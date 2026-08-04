import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { win32 } from "node:path";
import process from "node:process";
import {
  MAX_HOST_SHELL_STDIN_BYTES,
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
  executeFilesystemOperation,
  isFilesystemAction,
  resolveHostShellWorkingDirectory,
  resolveProcessWorkingDirectory,
} from "./filesystem-operations.js";
import {
  hostAccountShell,
  type HostAccountShell,
} from "./platform.js";

export type HostExecutorOptions = {
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  shell?: HostAccountShell;
};

export class HostExecutor implements OperationExecutor {
  readonly kind = "host" as const;
  private readonly operations = new Map<string, Set<RunningOperation>>();
  private readonly closedSessions = new WeakSet<RunningSession>();
  private readonly homeDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly shell: HostAccountShell;

  constructor(options: HostExecutorOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? homedir();
    if (!this.homeDirectory) {
      throw new Error("Unable to determine the Client account Home directory");
    }
    this.environment = processEnvironment(options.environment ?? process.env);
    this.shell = options.shell ?? hostAccountShell();
  }

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
    await mkdir(this.homeDirectory, { recursive: true });
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
    this.closedSessions.add(session);
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
    context: OperationExecutionContext = {},
  ): Promise<RunningOperation> {
    assertOperationCanStart(context.signal);
    if (this.closedSessions.has(session)) {
      throw new Error("Session is closed on this client");
    }
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
        this.homeDirectory,
        action,
        hooks,
        session.restrictions?.filesystem?.paths,
      ).then(() => ({ exitCode: 0 }));
      return { cancel: async () => {}, done };
    }

    const running =
      action.kind === "docker.logs"
        ? this.executeDockerLogs(action, hooks)
        : await this.executeProcess(session, action, hooks, context.signal);
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
    action: Extract<OperationAction, { kind: "process.exec" | "host.shell" }>,
    hooks: OperationHooks,
    signal: AbortSignal | undefined,
  ): Promise<RunningOperation> {
    if (action.kind === "host.shell") validateHostShellEnvironment(action.env);
    const cwd = action.kind === "host.shell"
      ? await resolveHostShellWorkingDirectory(this.homeDirectory, action.cwd)
      : await resolveProcessWorkingDirectory(this.homeDirectory, action.cwd);
    assertOperationCanStart(signal);
    if (this.closedSessions.has(session)) {
      throw new Error("Session closed before the Operation could start");
    }
    if (action.kind === "process.exec") {
      return spawnOperation(
        action.program,
        action.args,
        cwd,
        {},
        hooks,
      );
    }
    const input = decodeHostShellInput(action.stdinBase64);
    return spawnOperation(
      this.shell.program,
      this.shell.argsForCommand(action.command),
      cwd,
      action.env,
      hooks,
      input,
      this.environment,
      this.shell.windowsVerbatimArguments ?? false,
    );
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

function spawnOperation(
  program: string,
  args: string[],
  cwd: string | undefined,
  environment: Record<string, string>,
  hooks: OperationHooks,
  input?: Buffer,
  baseEnvironment: NodeJS.ProcessEnv = processEnvironment(),
  windowsVerbatimArguments = false,
): RunningOperation {
  const detached = process.platform !== "win32";
  const child = spawn(program, args, {
    cwd,
    env: operationEnvironment(baseEnvironment, environment),
    detached,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(process.platform === "win32" && windowsVerbatimArguments
      ? { windowsVerbatimArguments: true }
      : {}),
  });
  // A process may exit successfully without reading all supplied stdin. Node
  // reports that closed pipe asynchronously; consuming it keeps a bounded,
  // caller-provided input from crashing the Client process.
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  child.stdout.on("data", (chunk: Buffer) => hooks.stdout(chunk));
  child.stderr.on("data", (chunk: Buffer) => hooks.stderr(chunk));

  const done = new Promise<{ exitCode: number | null }>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolvePromise({ exitCode }));
  });
  let closed = false;
  void done.then(
    () => {
      closed = true;
    },
    () => {
      closed = true;
    },
  );
  let cancellation: Promise<void> | undefined;
  const cancel = async (): Promise<void> => {
    const pid = child.pid;
    if (!pid || closed) return;
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
      if (!processGroupExists(pid)) {
        if (await processExited(done, 500)) return;
        throw new Error("Unable to locate the process group before termination");
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

function validateHostShellEnvironment(environment: Record<string, string>): void {
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment key: ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`Invalid environment value for ${key}`);
    }
  }
}

function decodeHostShellInput(value: string | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("stdinBase64 must be valid standard base64");
  }
  const input = Buffer.from(value, "base64");
  if (input.length > MAX_HOST_SHELL_STDIN_BYTES) {
    throw new Error("Decoded stdinBase64 exceeds 1 MiB");
  }
  return input;
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
    const killer = spawn(
      windowsTaskkillPath(),
      ["/PID", String(pid), "/T", "/F"],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    );
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (error) reject(error);
      else resolvePromise();
    };
    const watchdog = setTimeout(() => {
      try {
        killer.kill("SIGKILL");
      } catch {}
      settle(new Error("taskkill timed out while terminating the process tree"));
    }, 4_000);
    watchdog.unref();
    killer.once("error", (error) => settle(error));
    killer.once("close", (exitCode) => {
      if (exitCode === 0) settle();
      else settle(new Error(`taskkill exited with status ${exitCode ?? "unknown"}`));
    });
  });
}

function windowsTaskkillPath(environment: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = environment.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new Error("SystemRoot must identify an absolute Windows system directory");
  }
  return win32.join(systemRoot, "System32", "taskkill.exe");
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

function processEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
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
      .map((key) => [key, source[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function operationEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  explicitEnvironment: Record<string, string>,
): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return { ...baseEnvironment, ...explicitEnvironment };
  }
  const merged = new Map<string, [string, string]>();
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (value !== undefined) merged.set(key.toLowerCase(), [key, value]);
  }
  for (const [key, value] of Object.entries(explicitEnvironment)) {
    merged.set(key.toLowerCase(), [key, value]);
  }
  return Object.fromEntries(merged.values());
}
