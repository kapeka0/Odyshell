import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import process from "node:process";
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
  type OperationHooks,
  type RunningOperation,
  type RunningSession,
  validateEnvironment,
  validateSessionPolicy,
} from "./executor.js";
import {
  executeFilesystemOperation,
  isFilesystemAction,
  resolveWorkspacePath,
} from "./filesystem-operations.js";

export class HostExecutor implements OperationExecutor {
  readonly kind = "host" as const;
  private readonly operations = new Map<string, Set<RunningOperation>>();

  async cleanupOrphans(): Promise<void> {}

  async openSession(
    sessionId: string,
    profile: ClientProfile,
    capabilities: Capability[],
    restrictions: SessionRestrictions | undefined,
    expiresAt: Date,
    onExpire: () => void,
  ): Promise<RunningSession> {
    if (profile.runner !== "host") throw new Error("HostExecutor requires a host profile");
    await mkdir(profile.workspaceRoot, { recursive: true });
    const ttlMilliseconds = validateSessionPolicy(
      profile,
      capabilities,
      restrictions,
      expiresAt,
    );
    return {
      id: sessionId,
      runner: "host",
      runtimeId: `host:${process.pid}:${sessionId}`,
      profile,
      capabilities: new Set(capabilities),
      restrictions,
      expiresAt,
      expiryTimer: setTimeout(onExpire, ttlMilliseconds),
    };
  }

  async closeSession(session: RunningSession): Promise<void> {
    clearTimeout(session.expiryTimer);
    const operations = [...(this.operations.get(session.id) ?? [])];
    await Promise.all(operations.map((operation) => operation.cancel()));
    this.operations.delete(session.id);
  }

  async execute(
    _operationId: string,
    session: RunningSession,
    action: OperationAction,
    hooks: OperationHooks,
  ): Promise<RunningOperation> {
    const needed = capabilityForAction(action);
    if (!session.capabilities.has(needed)) {
      throw new Error(`Capability ${needed} is not granted`);
    }
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
      const done = executeFilesystemOperation(
        session.profile.workspaceRoot,
        action,
        hooks,
        session.restrictions?.filesystem?.paths,
      ).then(() => ({ exitCode: 0 }));
      return { cancel: async () => {}, done };
    }

    const running =
      action.kind === "docker.logs"
        ? this.executeDockerLogs(action, hooks)
        : await this.executeProcess(session, action, hooks);
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

  private async executeProcess(
    session: RunningSession,
    action: Extract<OperationAction, { kind: "process.exec" | "process.shell" }>,
    hooks: OperationHooks,
  ): Promise<RunningOperation> {
    validateEnvironment(action.env);
    const cwd = await resolveWorkspacePath(session.profile.workspaceRoot, action.cwd);
    const command =
      action.kind === "process.exec"
        ? { program: action.program, args: action.args }
        : shellCommand(action.command);
    return spawnOperation(command.program, command.args, cwd, action.env, hooks);
  }

  private executeDockerLogs(
    action: Extract<OperationAction, { kind: "docker.logs" }>,
    hooks: OperationHooks,
  ): RunningOperation {
    const args = [
      "logs",
      "--tail",
      String(action.tail),
      ...(action.timestamps ? ["--timestamps"] : []),
      action.container,
    ];
    return spawnOperation("docker", args, undefined, {}, hooks);
  }
}

function shellCommand(command: string): { program: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      program: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return { program: "/bin/sh", args: ["-lc", command] };
}

function spawnOperation(
  program: string,
  args: string[],
  cwd: string | undefined,
  environment: Record<string, string>,
  hooks: OperationHooks,
): RunningOperation {
  const detached = process.platform !== "win32";
  const child = spawn(program, args, {
    cwd,
    env: { ...processEnvironment(), ...environment },
    detached,
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
    const pid = child.pid;
    if (child.exitCode !== null || !pid) return;
    cancellation ??= (async () => {
      try {
        if (detached) process.kill(-pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
      const forceTimer = setTimeout(() => {
        if (child.exitCode !== null || !child.pid) return;
        try {
          if (detached) process.kill(-pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
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
  return { child, cancel, done };
}

function processEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ];
  return Object.fromEntries(
    allowed
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
