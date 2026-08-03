import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  normalizeOperationPath,
  type OperationAction,
  type SessionPathRestriction,
} from "@odyshell/protocol";
import type { OperationHooks } from "./executor.js";

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

export async function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  allowMissing = false,
): Promise<string> {
  if (isAbsolute(requestedPath)) throw new Error("Path must be relative");
  const root = await realpath(workspaceRoot);
  const candidate = resolve(root, requestedPath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Path escapes the configured workspace");
  }

  if (!allowMissing) {
    const actual = await realpath(candidate);
    if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
      throw new Error("Resolved path escapes the configured workspace");
    }
    return actual;
  }

  let ancestor = dirname(candidate);
  while (ancestor !== root) {
    try {
      const actualAncestor = await realpath(ancestor);
      if (actualAncestor !== root && !actualAncestor.startsWith(`${root}${sep}`)) {
        throw new Error("Parent path escapes the configured workspace");
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
    return resolveWorkspacePath(workingDirectory, requestedPath);
  }
  const approved = resolve(requestedPath);
  const actual = await realpath(approved);
  if (relative(approved, actual) !== "") {
    throw new Error("Resolved working directory differs from the approved path");
  }
  return actual;
}

export async function resolveFilesystemPath(
  workspaceRoot: string,
  requestedPath: string,
  restrictions: SessionPathRestriction[] | undefined,
  allowMissing = false,
): Promise<string> {
  if (!isAbsolute(requestedPath)) {
    return resolveWorkspacePath(workspaceRoot, requestedPath, allowMissing);
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

export async function executeFilesystemOperation(
  workspaceRoot: string,
  action: FilesystemAction,
  hooks: OperationHooks,
  restrictions?: SessionPathRestriction[],
): Promise<void> {
  switch (action.kind) {
    case "fs.read": {
      const path = await resolveFilesystemPath(
        workspaceRoot,
        action.path,
        restrictions,
      );
      hooks.result(await readFile(path));
      break;
    }
    case "fs.list": {
      const path = await resolveFilesystemPath(
        workspaceRoot,
        action.path,
        restrictions,
      );
      const entries = await readdir(path, { withFileTypes: true });
      const result = await Promise.all(
        entries.map(async (entry) => {
          const info = await lstat(join(path, entry.name));
          return {
            name: entry.name,
            type: entry.isDirectory()
              ? "directory"
              : entry.isSymbolicLink()
                ? "symlink"
                : "file",
            size: info.size,
          };
        }),
      );
      hooks.result(Buffer.from(JSON.stringify(result)));
      break;
    }
    case "fs.search": {
      const root = await resolveFilesystemPath(
        workspaceRoot,
        action.path,
        restrictions,
      );
      const resultRoot = isAbsolute(action.path)
        ? dirname(root)
        : await realpath(workspaceRoot);
      const query = action.query.toLocaleLowerCase();
      const results: Array<{ path: string; type: "directory" | "file" | "symlink"; size: number }> =
        [];
      await searchDirectory(resultRoot, root, query, action.maxResults, results);
      hooks.result(Buffer.from(JSON.stringify(results)));
      break;
    }
    case "fs.stat": {
      const path = await resolveFilesystemPath(
        workspaceRoot,
        action.path,
        restrictions,
      );
      const info = await lstat(path);
      hooks.result(
        Buffer.from(
          JSON.stringify({
            path: isAbsolute(action.path)
              ? path.replaceAll("\\", "/")
              : relative(await realpath(workspaceRoot), path),
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
      const path = await resolveFilesystemPath(
        workspaceRoot,
        action.path,
        restrictions,
        true,
      );
      try {
        const existing = await lstat(path);
        if (existing.isSymbolicLink()) throw new Error("Writing through symlinks is denied");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (action.createParents) await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.odyshell-${randomUUID()}.tmp`;
      const data = Buffer.from(action.contentBase64, "base64");
      try {
        await writeFile(temporaryPath, data, { flag: "wx" });
        await rename(temporaryPath, path);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => {});
      }
      hooks.result(Buffer.from(JSON.stringify({ bytesWritten: data.length })));
      break;
    }
    case "fs.mkdir": {
      const path = await resolveFilesystemPath(
        workspaceRoot,
        action.path,
        restrictions,
        true,
      );
      await mkdir(path, { recursive: action.recursive });
      hooks.result(Buffer.from(JSON.stringify({ created: action.path })));
      break;
    }
    case "fs.remove": {
      if (
        action.path === "." ||
        action.path === "" ||
        dirname(resolve(action.path)) === resolve(action.path)
      ) {
        throw new Error("Removing the configured workspace is denied");
      }
      const lexicalPath = isAbsolute(action.path)
        ? resolve(action.path)
        : resolve(await realpath(workspaceRoot), action.path);
      if ((await lstat(lexicalPath)).isSymbolicLink()) {
        throw new Error("Removing symbolic links is denied");
      }
      const path = await resolveFilesystemPath(
        workspaceRoot,
        action.path,
        restrictions,
      );
      await rm(path, { recursive: action.recursive, force: false });
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
): Promise<void> {
  if (results.length >= maximum) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return;
    throw error;
  }
  for (const entry of entries) {
    if (results.length >= maximum) return;
    const entryPath = join(directory, entry.name);
    let info;
    try {
      info = await lstat(entryPath);
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
      await searchDirectory(searchRoot, entryPath, query, maximum, results);
    }
  }
}
