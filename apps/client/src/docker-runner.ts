import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  capabilityForAction,
  sessionScopeDecision,
  type Capability,
  type ClientProfile,
  type OperationAction,
  type SessionRestrictions,
} from "@odyshell/protocol";
import {
  type OperationExecutor,
  type OperationExecutionContext,
  type OperationHooks,
  type RunningOperation,
  type RunningSession,
  validateSessionPolicy,
  assertOperationCanStart,
} from "./executor.js";
import {
  isFilesystemAction,
  startFilesystemOperation,
} from "./filesystem-operations.js";
import { containerUser } from "./platform.js";

const workspaceWriteCapabilities = new Set(["fs.write", "fs.mkdir", "fs.remove"]);

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

export function isContainerAlreadyRemoved(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("No such container") ||
    (message.includes("removal of container") &&
      message.includes("is already in progress"))
  );
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

export class DockerRunner implements OperationExecutor {
  readonly kind = "docker" as const;
  private readonly operations = new Map<string, Set<RunningOperation>>();
  private readonly closedSessions = new WeakSet<RunningSession>();

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
    capabilities: Capability[],
    restrictions: SessionRestrictions | undefined,
    expiresAt: Date,
    onExpire: () => void,
  ): Promise<RunningSession> {
    if (profile.runner !== "docker") throw new Error("DockerRunner requires a Docker profile");
    await mkdir(profile.mountSource, { recursive: true });
    const name = `odyshell-${sessionId}`;
    const mountSource = resolve(profile.mountSource);
    const ttlMilliseconds = validateSessionPolicy(
      profile,
      capabilities,
      restrictions,
      expiresAt,
    );
    if (profile.network !== "none") {
      throw new Error("Network access is denied by local policy");
    }
    const workspaceWritable = capabilities.some((capability) =>
      workspaceWriteCapabilities.has(capability),
    );

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
      "none",
      "--ipc",
      "none",
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
      `type=bind,source=${mountSource},target=/workspace${workspaceWritable ? "" : ",readonly"}`,
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
      runner: "docker",
      runtimeId: containerId,
      containerName: name,
      profile,
      capabilities: new Set(capabilities),
      restrictions,
      expiresAt,
      expiryTimer,
    };
  }

  async closeSession(session: RunningSession): Promise<void> {
    this.closedSessions.add(session);
    clearTimeout(session.expiryTimer);
    const operations = [...(this.operations.get(session.id) ?? [])];
    await Promise.all(operations.map((operation) => operation.cancel()));
    this.operations.delete(session.id);
    if (!session.containerName) return;
    try {
      await dockerCapture(["rm", "-f", session.containerName]);
    } catch (error) {
      if (!isContainerAlreadyRemoved(error)) throw error;
    }
  }

  async execute(
    operationId: string,
    session: RunningSession,
    action: OperationAction,
    hooks: OperationHooks,
    context: OperationExecutionContext = {},
  ): Promise<RunningOperation> {
    assertOperationCanStart(context.signal);
    if (this.closedSessions.has(session)) {
      throw new Error("Session is closed on this client");
    }
    if (session.profile.runner !== "docker") {
      throw new Error("DockerRunner requires a Docker profile");
    }
    const needed = capabilityForAction(action);
    if (!session.capabilities.has(needed)) throw new Error(`Capability ${needed} is not granted`);
    const restrictionDecision = session.restrictions
      ? sessionScopeDecision(
      {
        machineId: "local",
        profile: "workspace",
        capabilities: [...session.capabilities],
        restrictions: session.restrictions,
      },
      "local",
      action,
      )
      : { allowed: true as const };
    if (!restrictionDecision.allowed) {
      throw new Error(`Operation denied by local Session scope: ${restrictionDecision.code}`);
    }

    if (isFilesystemAction(action)) {
      if (isAbsolute(action.path)) {
        throw new Error("Absolute filesystem paths require a host execution profile");
      }
      const running = startFilesystemOperation(
        session.profile.mountSource,
        action,
        hooks,
        session.restrictions?.filesystem?.paths,
        context.signal,
      );
      const active = this.operations.get(session.id) ?? new Set<RunningOperation>();
      active.add(running);
      this.operations.set(session.id, active);
      const cleanup = (): void => {
        active.delete(running);
        if (active.size === 0) this.operations.delete(session.id);
      };
      void running.done.then(cleanup, cleanup);
      return running;
    }
    if (action.kind === "docker.logs") {
      throw new Error("docker.logs is unavailable inside a Docker execution profile");
    }
    if (action.kind === "host.shell") {
      throw new Error("host.shell is unavailable inside a Docker execution profile");
    }
    const containerName = session.containerName;
    if (!containerName) throw new Error("Docker session has no container");

    const pidFile = `/tmp/odyshell-${operationId}.pid`;
    const dockerArgs = ["exec", "-i", "-w", containerWorkspacePath(action.cwd)];
    dockerArgs.push(containerName);
    dockerArgs.push(
      "/bin/sh",
      "-c",
      'echo $$ > "$1"; shift; exec "$@"',
      "odyshell",
      pidFile,
      action.program,
      ...action.args,
    );

    assertOperationCanStart(context.signal);
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
    let cancellation: Promise<void> | undefined;
    const cancel = async (): Promise<void> => {
      if (child.exitCode !== null) return;
      cancellation ??= (async () => {
        await dockerCapture([
          "exec",
          containerName,
          "/bin/sh",
          "-c",
          'test -f "$1" && kill -TERM "$(cat "$1")" 2>/dev/null || true',
          "odyshell",
          pidFile,
        ]).catch((error: unknown) => {
          if (
            !String(error).includes("No such container") &&
            !String(error).includes("is not running") &&
            !String(error).includes("unable to upgrade to tcp")
          ) {
            throw error;
          }
        });
        const forceTimer = setTimeout(() => {
          if (child.exitCode === null) child.kill();
        }, 2_000);
        forceTimer.unref();
        try {
          await Promise.race([
            done.catch(() => ({ exitCode: null })),
            new Promise((resolvePromise) => {
              const safetyTimer = setTimeout(resolvePromise, 4_000);
              safetyTimer.unref();
            }),
          ]);
        } finally {
          clearTimeout(forceTimer);
        }
      })();
      await cancellation;
    };
    const running = { child, cancel, done };
    const active = this.operations.get(session.id) ?? new Set<RunningOperation>();
    active.add(running);
    this.operations.set(session.id, active);
    const cleanup = (): void => {
      active.delete(running);
      if (active.size === 0) this.operations.delete(session.id);
    };
    void done.then(cleanup, cleanup);
    return running;
  }

}
