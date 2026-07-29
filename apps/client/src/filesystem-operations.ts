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
import type { OperationAction } from "@odyshell/protocol";
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

export async function executeFilesystemOperation(
  workspaceRoot: string,
  action: FilesystemAction,
  hooks: OperationHooks,
): Promise<void> {
  switch (action.kind) {
    case "fs.read": {
      const path = await resolveWorkspacePath(workspaceRoot, action.path);
      hooks.result(await readFile(path));
      break;
    }
    case "fs.list": {
      const path = await resolveWorkspacePath(workspaceRoot, action.path);
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
      const root = await resolveWorkspacePath(workspaceRoot, action.path);
      const workspace = await realpath(workspaceRoot);
      const query = action.query.toLocaleLowerCase();
      const results: Array<{ path: string; type: "directory" | "file" | "symlink"; size: number }> =
        [];
      await searchDirectory(workspace, root, query, action.maxResults, results);
      hooks.result(Buffer.from(JSON.stringify(results)));
      break;
    }
    case "fs.stat": {
      const path = await resolveWorkspacePath(workspaceRoot, action.path);
      const info = await lstat(path);
      hooks.result(
        Buffer.from(
          JSON.stringify({
            path: relative(await realpath(workspaceRoot), path),
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
      const path = await resolveWorkspacePath(workspaceRoot, action.path, true);
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
      const path = await resolveWorkspacePath(workspaceRoot, action.path, true);
      await mkdir(path, { recursive: action.recursive });
      hooks.result(Buffer.from(JSON.stringify({ created: action.path })));
      break;
    }
    case "fs.remove": {
      if (action.path === "." || action.path === "") {
        throw new Error("Removing the configured workspace is denied");
      }
      const path = await resolveWorkspacePath(workspaceRoot, action.path);
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
