import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MAX_FILESYSTEM_WRITE_BYTES,
  normalizeOperationPath,
  type OperationAction,
  type SessionPathRestriction,
} from "@odyshell/protocol";
import type { OperationHooks, RunningOperation } from "./executor.js";

const MAX_FILESYSTEM_READ_BYTES = 1024 * 1024;
const MAX_FILESYSTEM_LIST_ENTRIES = 1_000;
const MAX_FILESYSTEM_SEARCH_NODES = 2_048;
const MAX_FILESYSTEM_SEARCH_DEPTH = 32;
const MAX_FILESYSTEM_WRITE_BASE64_LENGTH =
  4 * Math.ceil(MAX_FILESYSTEM_WRITE_BYTES / 3);
const STANDARD_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
type OpenDirectory = Awaited<ReturnType<typeof opendir>>;

export type FilesystemAction = Extract<
  OperationAction,
  {
    kind:
      | "fs.stat"
      | "fs.list"
      | "fs.search"
      | "fs.read"
      | "fs.write"
      | "fs.mkdir"
      | "fs.remove";
  }
>;

export function isFilesystemAction(action: OperationAction): action is FilesystemAction {
  return action.kind.startsWith("fs.");
}

export async function resolveHomePath(
  homeDirectory: string,
  requestedPath: string,
  allowMissing = false,
): Promise<string> {
  if (isAbsolute(requestedPath)) throw new Error("Path must be relative");
  const root = await realpath(homeDirectory);
  const candidate = resolve(root, requestedPath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Path escapes the account Home");
  }

  if (!allowMissing) {
    const actual = await realpath(candidate);
    if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
      throw new Error("Resolved path escapes the account Home");
    }
    return actual;
  }

  let ancestor = dirname(candidate);
  while (ancestor !== root) {
    try {
      const actualAncestor = await realpath(ancestor);
      if (actualAncestor !== root && !actualAncestor.startsWith(`${root}${sep}`)) {
        throw new Error("Parent path escapes the account Home");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  return candidate;
}

export async function resolveProcessWorkingDirectory(
  workingDirectory: string,
  requestedPath: string,
): Promise<string> {
  if (!isAbsolute(requestedPath)) {
    return resolveHomePath(workingDirectory, requestedPath);
  }
  const approved = resolve(requestedPath);
  const actual = await realpath(approved);
  if (relative(approved, actual) !== "") {
    throw new Error("Resolved working directory differs from the approved path");
  }
  return actual;
}

export async function resolveHostShellWorkingDirectory(
  homeDirectory: string,
  requestedPath: string,
): Promise<string> {
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(await realpath(homeDirectory), requestedPath);
  return realpath(candidate);
}

export async function resolveFilesystemPath(
  homeDirectory: string,
  requestedPath: string,
  restrictions: SessionPathRestriction[] | undefined,
  allowMissing = false,
): Promise<string> {
  if (!isAbsolute(requestedPath)) {
    const path = await resolveHomePath(
      homeDirectory,
      requestedPath,
      allowMissing,
    );
    if (restrictions !== undefined) {
      await assertRelativeFilesystemRestriction(
        homeDirectory,
        requestedPath,
        restrictions,
      );
    }
    return path;
  }
  const candidate = resolve(requestedPath);
  if (restrictions === undefined) {
    if (!allowMissing) return realpath(candidate);

    let ancestor = candidate;
    while (true) {
      try {
        await realpath(ancestor);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
  const normalized = normalizeOperationPath(requestedPath);
  const restriction = restrictions?.find((candidate) => {
    const root = normalizeOperationPath(candidate.path);
    if (!isAbsolute(candidate.path)) return false;
    return (
      normalized === root ||
      (candidate.includeDescendants &&
        (root === "/" || /^[A-Za-z]:\/$/.test(root)
          ? normalized.startsWith(root)
          : normalized.startsWith(`${root}/`)))
    );
  });
  if (!restriction) {
    throw new Error("Absolute path is not granted by the local Session scope");
  }

  const boundary = resolve(restriction.path);
  const lexicalRelative = relative(boundary, candidate);
  if (lexicalRelative !== "" && (
    !restriction.includeDescendants ||
    lexicalRelative.startsWith("..") ||
    isAbsolute(lexicalRelative)
  )) {
    throw new Error("Path escapes the approved absolute scope");
  }

  if (!allowMissing) {
    const [actualBoundary, actual] = await Promise.all([
      realpath(boundary),
      realpath(candidate),
    ]);
    const actualRelative = relative(actualBoundary, actual);
    if (actualRelative !== "" && (
      !restriction.includeDescendants ||
      actualRelative.startsWith("..") ||
      isAbsolute(actualRelative)
    )) {
      throw new Error("Resolved path escapes the approved absolute scope");
    }
    return actual;
  }

  let ancestor = candidate;
  let actualAncestor: string;
  while (true) {
    try {
      actualAncestor = await realpath(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (!restriction.includeDescendants && relative(ancestor, actualAncestor!) !== "") {
    throw new Error("Resolved path differs from the approved absolute path");
  }
  if (restriction.includeDescendants && candidate !== boundary) {
    let actualBoundary: string;
    try {
      actualBoundary = await realpath(boundary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "The approved absolute root must exist before creating descendants",
        );
      }
      throw error;
    }
    const actualRelative = relative(actualBoundary, actualAncestor!);
    if (
      actualRelative !== "" &&
      (actualRelative.startsWith("..") || isAbsolute(actualRelative))
    ) {
      throw new Error("Resolved path escapes the approved absolute scope");
    }
  }
  return candidate;
}

async function assertRelativeFilesystemRestriction(
  homeDirectory: string,
  requestedPath: string,
  restrictions: SessionPathRestriction[],
): Promise<void> {
  const normalized = normalizeOperationPath(requestedPath);
  const matching = restrictions.filter((restriction) => {
    if (isAbsolute(restriction.path)) return false;
    const root = normalizeOperationPath(restriction.path);
    return (
      normalized === root ||
      (restriction.includeDescendants &&
        (root === "." || normalized.startsWith(`${root}/`)))
    );
  });
  if (matching.length === 0) {
    throw new Error("Relative path is not granted by the local Session scope");
  }

  const home = await realpath(homeDirectory);
  const candidate = resolve(home, requestedPath);
  let denied: unknown;
  for (const restriction of matching) {
    try {
      await assertRelativePathWithinRestriction(home, candidate, restriction);
      return;
    } catch (error) {
      denied = error;
    }
  }
  throw denied;
}

async function assertRelativePathWithinRestriction(
  home: string,
  candidate: string,
  restriction: SessionPathRestriction,
): Promise<void> {
  const boundary = resolve(home, restriction.path);
  const resolvedBoundary = await nearestExistingPath(boundary);
  if (resolvedBoundary.path !== boundary) {
    if (relative(resolvedBoundary.path, resolvedBoundary.actual) !== "") {
      throw new Error("Relative path scope resolves through a symbolic link");
    }
    const resolvedCandidate = await nearestExistingPath(candidate);
    if (relative(resolvedCandidate.path, resolvedCandidate.actual) !== "") {
      throw new Error("Relative path escapes through a symbolic link");
    }
    return;
  }
  if (relative(boundary, resolvedBoundary.actual) !== "") {
    throw new Error("Relative path scope resolves through a symbolic link");
  }

  const resolvedCandidate = await nearestExistingPath(candidate);
  const actualRelative = relative(
    resolvedBoundary.actual,
    resolvedCandidate.actual,
  );
  if (
    actualRelative !== "" &&
    (!restriction.includeDescendants ||
      actualRelative.startsWith("..") ||
      isAbsolute(actualRelative))
  ) {
    throw new Error("Resolved path escapes the approved relative scope");
  }
}

async function nearestExistingPath(
  candidate: string,
): Promise<{ path: string; actual: string }> {
  let path = candidate;
  while (true) {
    try {
      return { path, actual: await realpath(path) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      path = parent;
    }
  }
}

export function startFilesystemOperation(
  homeDirectory: string,
  action: FilesystemAction,
  hooks: OperationHooks,
  restrictions?: SessionPathRestriction[],
  signal?: AbortSignal,
): RunningOperation {
  const cancellation = new AbortController();
  const cancelFromSignal = (): void => cancellation.abort();
  if (signal) {
    signal.addEventListener("abort", cancelFromSignal, { once: true });
    if (signal.aborted) cancellation.abort();
  }
  const done = executeFilesystemOperation(
    homeDirectory,
    action,
    hooks,
    restrictions,
    cancellation.signal,
  ).then(
    () => ({ exitCode: 0 }),
    (error: unknown) => {
      if (cancellation.signal.aborted) return { exitCode: null };
      throw error;
    },
  ).finally(() => signal?.removeEventListener("abort", cancelFromSignal));
  return {
    cancel: async () => {
      cancellation.abort();
      await done;
    },
    done,
  };
}

async function executeFilesystemOperation(
  homeDirectory: string,
  action: FilesystemAction,
  hooks: OperationHooks,
  restrictions: SessionPathRestriction[] | undefined,
  signal: AbortSignal,
): Promise<void> {
  assertFilesystemOperationActive(signal);
  switch (action.kind) {
    case "fs.read": {
      const path = await resolveFilesystemPath(
        homeDirectory,
        action.path,
        restrictions,
      );
      assertFilesystemOperationActive(signal);
      const file = await open(path, "r");
      try {
        const info = await file.stat();
        assertFilesystemOperationActive(signal);
        if (!info.isFile()) {
          throw new Error("Filesystem read requires a regular file");
        }
        if (info.size > MAX_FILESYSTEM_READ_BYTES) {
          throw new Error("Filesystem read exceeds the 1 MiB limit");
        }
        const data = Buffer.allocUnsafe(MAX_FILESYSTEM_READ_BYTES + 1);
        let offset = 0;
        while (offset < data.length) {
          assertFilesystemOperationActive(signal);
          const { bytesRead } = await file.read(
            data,
            offset,
            data.length - offset,
            offset,
          );
          assertFilesystemOperationActive(signal);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > MAX_FILESYSTEM_READ_BYTES) {
          throw new Error("Filesystem read exceeds the 1 MiB limit");
        }
        assertFilesystemOperationActive(signal);
        hooks.result(data.subarray(0, offset));
      } finally {
        await file.close();
      }
      break;
    }
    case "fs.list": {
      const path = await resolveFilesystemPath(
        homeDirectory,
        action.path,
        restrictions,
      );
      assertFilesystemOperationActive(signal);
      const directory = await opendir(path);
      const result: Array<{
        name: string;
        type: "directory" | "file" | "symlink";
        size: number;
      }> = [];
      try {
        while (true) {
          assertFilesystemOperationActive(signal);
          const entry = await directory.read();
          assertFilesystemOperationActive(signal);
          if (!entry) break;
          if (result.length >= MAX_FILESYSTEM_LIST_ENTRIES) {
            throw new Error("Filesystem list exceeds the 1,000-entry limit");
          }
          const info = await lstat(join(path, entry.name));
          assertFilesystemOperationActive(signal);
          result.push({
            name: entry.name,
            type: entry.isDirectory()
              ? "directory"
              : entry.isSymbolicLink()
                ? "symlink"
                : "file",
            size: info.size,
          });
        }
      } finally {
        await closeDirectory(directory);
      }
      assertFilesystemOperationActive(signal);
      hooks.result(Buffer.from(JSON.stringify(result)));
      break;
    }
    case "fs.search": {
      const root = await resolveFilesystemPath(
        homeDirectory,
        action.path,
        restrictions,
      );
      const resultRoot = isAbsolute(action.path)
        ? dirname(root)
        : await realpath(homeDirectory);
      const query = action.query.toLocaleLowerCase();
      const results: Array<{ path: string; type: "directory" | "file" | "symlink"; size: number }> =
        [];
      await searchDirectory(
        resultRoot,
        root,
        query,
        action.maxResults,
        results,
        { visitedNodes: 0 },
        0,
        signal,
      );
      assertFilesystemOperationActive(signal);
      hooks.result(Buffer.from(JSON.stringify(results)));
      break;
    }
    case "fs.stat": {
      const path = await resolveFilesystemPath(
        homeDirectory,
        action.path,
        restrictions,
      );
      const info = await lstat(path);
      assertFilesystemOperationActive(signal);
      const resultPath = isAbsolute(action.path)
        ? path.replaceAll("\\", "/")
        : relative(await realpath(homeDirectory), path);
      assertFilesystemOperationActive(signal);
      hooks.result(
        Buffer.from(
          JSON.stringify({
            path: resultPath,
            type: info.isDirectory()
              ? "directory"
              : info.isSymbolicLink()
                ? "symlink"
                : "file",
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          }),
        ),
      );
      break;
    }
    case "fs.write": {
      const data = decodeFilesystemWrite(action.contentBase64);
      const path = await resolveFilesystemPath(
        homeDirectory,
        action.path,
        restrictions,
        true,
      );
      assertFilesystemOperationActive(signal);
      try {
        const existing = await lstat(path);
        if (existing.isSymbolicLink()) throw new Error("Writing through symlinks is denied");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      assertFilesystemOperationActive(signal);
      if (action.createParents) await mkdir(dirname(path), { recursive: true });
      assertFilesystemOperationActive(signal);
      const temporaryPath = `${path}.odyshell-${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, data, { flag: "wx", signal });
        assertFilesystemOperationActive(signal);
        await rename(temporaryPath, path);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => {});
      }
      assertFilesystemOperationActive(signal);
      hooks.result(Buffer.from(JSON.stringify({ bytesWritten: data.length })));
      break;
    }
    case "fs.mkdir": {
      const path = await resolveFilesystemPath(
        homeDirectory,
        action.path,
        restrictions,
        true,
      );
      assertFilesystemOperationActive(signal);
      await mkdir(path, { recursive: action.recursive });
      assertFilesystemOperationActive(signal);
      hooks.result(Buffer.from(JSON.stringify({ created: action.path })));
      break;
    }
    case "fs.remove": {
      if (action.recursive) {
        throw new Error("Recursive filesystem removal is unavailable");
      }
      if (
        action.path === "." ||
        action.path === "" ||
        dirname(resolve(action.path)) === resolve(action.path)
      ) {
        throw new Error("Removing the account Home is denied");
      }
      const lexicalPath = isAbsolute(action.path)
        ? resolve(action.path)
        : resolve(await realpath(homeDirectory), action.path);
      if ((await lstat(lexicalPath)).isSymbolicLink()) {
        throw new Error("Removing symbolic links is denied");
      }
      const path = await resolveFilesystemPath(
        homeDirectory,
        action.path,
        restrictions,
      );
      assertFilesystemOperationActive(signal);
      const info = await lstat(path);
      assertFilesystemOperationActive(signal);
      if (info.isDirectory()) await rmdir(path);
      else await unlink(path);
      assertFilesystemOperationActive(signal);
      hooks.result(Buffer.from(JSON.stringify({ removed: action.path })));
      break;
    }
  }
}

async function searchDirectory(
  searchRoot: string,
  directory: string,
  query: string,
  maximum: number,
  results: Array<{ path: string; type: "directory" | "file" | "symlink"; size: number }>,
  budget: { visitedNodes: number },
  depth: number,
  signal: AbortSignal,
): Promise<void> {
  assertFilesystemOperationActive(signal);
  if (results.length >= maximum) return;
  if (depth > MAX_FILESYSTEM_SEARCH_DEPTH) {
    throw new Error("Filesystem search exceeds the 32-directory depth limit");
  }
  let handle: OpenDirectory;
  try {
    handle = await opendir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return;
    throw error;
  }
  try {
    while (results.length < maximum) {
      assertFilesystemOperationActive(signal);
      const entry = await handle.read();
      assertFilesystemOperationActive(signal);
      if (!entry) return;
      if (budget.visitedNodes >= MAX_FILESYSTEM_SEARCH_NODES) {
        throw new Error("Filesystem search exceeds the 2,048-node limit");
      }
      budget.visitedNodes += 1;
      const entryPath = join(directory, entry.name);
      let info;
      try {
        info = await lstat(entryPath);
        assertFilesystemOperationActive(signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EACCES" || code === "EPERM") continue;
        throw error;
      }
      const type = entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "symlink"
          : "file";
      if (entry.name.toLocaleLowerCase().includes(query)) {
        results.push({
          path: relative(searchRoot, entryPath).replaceAll("\\", "/"),
          type,
          size: info.size,
        });
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await searchDirectory(
          searchRoot,
          entryPath,
          query,
          maximum,
          results,
          budget,
          depth + 1,
          signal,
        );
      }
    }
  } finally {
    await closeDirectory(handle);
  }
}

function assertFilesystemOperationActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Filesystem Operation was cancelled");
}

function decodeFilesystemWrite(value: string): Buffer {
  if (value.length > MAX_FILESYSTEM_WRITE_BASE64_LENGTH) {
    throw new Error("Filesystem write exceeds the 1 MiB limit");
  }
  if (!STANDARD_BASE64_PATTERN.test(value)) {
    throw new Error("Filesystem write content must be valid standard base64");
  }
  const paddingBytes = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - paddingBytes;
  if (decodedBytes > MAX_FILESYSTEM_WRITE_BYTES) {
    throw new Error("Filesystem write exceeds the 1 MiB limit");
  }
  return Buffer.from(value, "base64");
}

async function closeDirectory(directory: OpenDirectory): Promise<void> {
  try {
    await directory.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
  }
}
