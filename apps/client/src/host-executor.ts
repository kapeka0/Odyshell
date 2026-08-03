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
  resolveProcessWorkingDirectory,
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
    const cwd = await resolveProcessWorkingDirectory(
      session.profile.workspaceRoot,
      action.cwd,
    );
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
    if (child.exitCode !== null || child.signalCode !== null || !pid) return;
    cancellation ??= (async () => {
      if (process.platform === "win32") {
        let terminationError: unknown;
        try {
          await terminateWindowsProcessTree(pid);
        } catch (error) {
          terminationError = error;
        }
        if (await processExited(done, 4_000)) return;
        throw terminationError instanceof Error
          ? terminationError
          : new Error("Unable to confirm Windows process-tree termination");
      }
      signalProcessGroup(pid, "SIGTERM");
      if (await processGroupExited(pid, 2_000)) {
        if (await processExited(done, 500)) return;
        throw new Error("Unable to confirm process exit after process-group termination");
      }
      signalProcessGroup(pid, "SIGKILL");
      if (!(await processGroupExited(pid, 2_000))) {
        throw new Error("Unable to confirm process-group termination");
      }
      if (!(await processExited(done, 500))) {
        throw new Error("Unable to confirm process exit after process-group termination");
      }
    })();
    await cancellation;
  };
  return { child, cancel, done };
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function processGroupExited(
  pid: number,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return true;
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", reject);
    killer.once("close", (exitCode) => {
      if (exitCode === 0) resolvePromise();
      else reject(new Error(`taskkill exited with status ${exitCode ?? "unknown"}`));
    });
  });
}

async function processExited(
  done: Promise<{ exitCode: number | null }>,
  timeoutMilliseconds: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const timeout = setTimeout(() => resolvePromise(false), timeoutMilliseconds);
    timeout.unref();
    void done.then(
      () => {
        clearTimeout(timeout);
        resolvePromise(true);
      },
      () => {
        clearTimeout(timeout);
        resolvePromise(true);
      },
    );
  });
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
