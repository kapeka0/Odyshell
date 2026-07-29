import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  capabilityForAction,
  type ClientProfile,
  type OperationAction,
} from "@odyshell/protocol";
import { containerUser } from "./platform.js";

export type RunningSession = {
  id: string;
  containerId: string;
  containerName: string;
  profile: ClientProfile;
  capabilities: Set<string>;
  expiresAt: Date;
  expiryTimer: NodeJS.Timeout;
};

export type OperationHooks = {
  stdout: (data: Buffer) => void;
  stderr: (data: Buffer) => void;
  result: (data: Buffer) => void;
};

export type RunningOperation = {
  child?: ChildProcessWithoutNullStreams;
  cancel: () => Promise<void>;
  done: Promise<{ exitCode: number | null }>;
};

async function dockerCapture(args: string[], input?: Buffer): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `docker exited ${code}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export type DockerRuntime = {
  os: "linux";
  architecture: string;
  version: string;
  operatingSystem: string;
};

export function parseDockerRuntime(raw: string): DockerRuntime {
  const [os, architecture, version, operatingSystem] = raw.split("\t");
  if (os !== "linux") {
    throw new Error(
      "Odyshell requires Docker's Linux container engine. On Windows, switch Docker Desktop to Linux containers.",
    );
  }
  if (!architecture || !version) throw new Error("Docker returned incomplete runtime information");
  return {
    os,
    architecture,
    version,
    operatingSystem: operatingSystem ?? "Docker",
  };
}

export async function inspectDockerRuntime(): Promise<DockerRuntime> {
  let raw: string;
  try {
    raw = await dockerCapture([
      "info",
      "--format",
      "{{.OSType}}\t{{.Architecture}}\t{{.ServerVersion}}\t{{.OperatingSystem}}",
    ]);
  } catch (error) {
    throw new Error(
      `Docker is unavailable. Start Docker Engine or Docker Desktop and try again. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseDockerRuntime(raw);
}

function containerWorkspacePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error("Path escapes the session workspace");
  }
  return normalized === "." || normalized === "" ? "/workspace" : `/workspace/${normalized}`;
}

async function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  allowMissing = false,
): Promise<string> {
  if (isAbsolute(requestedPath)) throw new Error("Path must be relative");
  const root = await realpath(workspaceRoot);
  const candidate = resolve(root, requestedPath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Path escapes the session workspace");
  }

  if (!allowMissing) {
    const actual = await realpath(candidate);
    if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
      throw new Error("Resolved path escapes the session workspace");
    }
    return actual;
  }

  let ancestor = dirname(candidate);
  while (ancestor !== root) {
    try {
      const actualAncestor = await realpath(ancestor);
      if (actualAncestor !== root && !actualAncestor.startsWith(`${root}${sep}`)) {
        throw new Error("Parent path escapes the session workspace");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  return candidate;
}

export class DockerRunner {
  constructor(private readonly machineId: string) {}

  async preflight(): Promise<DockerRuntime> {
    return inspectDockerRuntime();
  }

  async cleanupOrphans(): Promise<void> {
    const ids = await dockerCapture([
      "ps",
      "-aq",
      "--filter",
      `label=odyshell.machine=${this.machineId}`,
    ]);
    if (ids) await dockerCapture(["rm", "-f", ...ids.split(/\s+/)]);
  }

  async openSession(
    sessionId: string,
    profile: ClientProfile,
    capabilities: string[],
    expiresAt: Date,
    onExpire: () => void,
  ): Promise<RunningSession> {
    await mkdir(profile.workspaceRoot, { recursive: true });
    const name = `odyshell-${sessionId}`;
    const mountSource = resolve(profile.workspaceRoot);
    const ttlMilliseconds = expiresAt.getTime() - Date.now();
    if (ttlMilliseconds <= 0 || ttlMilliseconds > profile.maxSessionTtlSeconds * 1000) {
      throw new Error("Requested session TTL violates local policy");
    }
    for (const capability of capabilities) {
      if (!profile.capabilities.includes(capability as never)) {
        throw new Error(`Capability ${capability} is denied by local policy`);
      }
    }

    const args = [
      "run",
      "-d",
      "--rm",
      "--pull",
      "missing",
      "--name",
      name,
      "--label",
      `odyshell.machine=${this.machineId}`,
      "--label",
      `odyshell.session=${sessionId}`,
      "--network",
      profile.network,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      "128",
      "--memory",
      "256m",
      "--cpus",
      "1",
      "--user",
      containerUser(),
      "--mount",
      `type=bind,source=${mountSource},target=/workspace`,
      "--workdir",
      "/workspace",
      profile.image,
      "/bin/sh",
      "-c",
      "trap 'exit 0' TERM INT; while :; do sleep 3600; done",
    ];
    const containerId = await dockerCapture(args);
    const expiryTimer = setTimeout(onExpire, ttlMilliseconds);
    return {
      id: sessionId,
      containerId,
      containerName: name,
      profile,
      capabilities: new Set(capabilities),
      expiresAt,
      expiryTimer,
    };
  }

  async closeSession(session: RunningSession): Promise<void> {
    clearTimeout(session.expiryTimer);
    try {
      await dockerCapture(["rm", "-f", session.containerName]);
    } catch (error) {
      if (!String(error).includes("No such container")) throw error;
    }
  }

  async execute(
    operationId: string,
    session: RunningSession,
    action: OperationAction,
    hooks: OperationHooks,
  ): Promise<RunningOperation> {
    const needed = capabilityForAction(action);
    if (!session.capabilities.has(needed)) throw new Error(`Capability ${needed} is not granted`);

    if (action.kind !== "process.exec" && action.kind !== "process.shell") {
      const done = this.executeFilesystem(session, action, hooks).then(() => ({ exitCode: 0 }));
      return { cancel: async () => {}, done };
    }

    const pidFile = `/tmp/odyshell-${operationId}.pid`;
    const dockerArgs = ["exec", "-i", "-w", containerWorkspacePath(action.cwd)];
    for (const [key, value] of Object.entries(action.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
      dockerArgs.push("-e", `${key}=${value}`);
    }
    dockerArgs.push(session.containerName);
    if (action.kind === "process.exec") {
      dockerArgs.push(
        "/bin/sh",
        "-c",
        'echo $$ > "$1"; shift; exec "$@"',
        "odyshell",
        pidFile,
        action.program,
        ...action.args,
      );
    } else {
      dockerArgs.push(
        "/bin/sh",
        "-c",
        'echo $$ > "$1"; shift; exec /bin/sh -lc "$1"',
        "odyshell",
        pidFile,
        action.command,
      );
    }

    const child = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => hooks.stdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => hooks.stderr(chunk));

    const done = new Promise<{ exitCode: number | null }>((resolvePromise, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => resolvePromise({ exitCode }));
    });
    const cancel = async (): Promise<void> => {
      await dockerCapture([
        "exec",
        session.containerName,
        "/bin/sh",
        "-c",
        'test -f "$1" && kill -TERM "$(cat "$1")" 2>/dev/null || true',
        "odyshell",
        pidFile,
      ]);
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 2_000).unref();
    };
    return { child, cancel, done };
  }

  private async executeFilesystem(
    session: RunningSession,
    action: Exclude<OperationAction, { kind: "process.exec" | "process.shell" }>,
    hooks: OperationHooks,
  ): Promise<void> {
    const workspace = session.profile.workspaceRoot;
    switch (action.kind) {
      case "fs.read": {
        const path = await resolveWorkspacePath(workspace, action.path);
        hooks.result(await readFile(path));
        break;
      }
      case "fs.list": {
        const path = await resolveWorkspacePath(workspace, action.path);
        const entries = await readdir(path, { withFileTypes: true });
        const result = await Promise.all(
          entries.map(async (entry) => {
            const entryPath = join(path, entry.name);
            const info = await lstat(entryPath);
            return {
              name: entry.name,
              type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
              size: info.size,
            };
          }),
        );
        hooks.result(Buffer.from(JSON.stringify(result)));
        break;
      }
      case "fs.stat": {
        const path = await resolveWorkspacePath(workspace, action.path);
        const info = await lstat(path);
        hooks.result(
          Buffer.from(
            JSON.stringify({
              path: relative(await realpath(workspace), path),
              type: info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "file",
              size: info.size,
              modifiedAt: info.mtime.toISOString(),
            }),
          ),
        );
        break;
      }
      case "fs.write": {
        const path = await resolveWorkspacePath(workspace, action.path, true);
        try {
          const existing = await lstat(path);
          if (existing.isSymbolicLink()) throw new Error("Writing through symlinks is denied");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (action.createParents) await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.odyshell-${randomUUID()}.tmp`;
        const data = Buffer.from(action.contentBase64, "base64");
        await writeFile(temp, data, { flag: "wx" });
        await rename(temp, path);
        hooks.result(Buffer.from(JSON.stringify({ bytesWritten: data.length })));
        break;
      }
      case "fs.mkdir": {
        const path = await resolveWorkspacePath(workspace, action.path, true);
        await mkdir(path, { recursive: action.recursive });
        hooks.result(Buffer.from(JSON.stringify({ created: action.path })));
        break;
      }
      case "fs.remove": {
        if (action.path === "." || action.path === "") throw new Error("Removing workspace root is denied");
        const path = await resolveWorkspacePath(workspace, action.path);
        await rm(path, { recursive: action.recursive, force: false });
        hooks.result(Buffer.from(JSON.stringify({ removed: action.path })));
        break;
      }
    }
  }
}
