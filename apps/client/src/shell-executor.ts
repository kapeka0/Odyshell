import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { win32 } from "node:path";
import process from "node:process";
import { hostAccountShell, type HostAccountShell } from "./platform.js";

export type CommandHooks = {
  stdout(data: Buffer): void;
  stderr(data: Buffer): void;
};

export type RunningCommand = {
  cancel(): Promise<void>;
  done: Promise<{ exitCode: number | null }>;
};

export type ShellExecutorOptions = {
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  shell?: HostAccountShell;
};

export class ShellExecutor {
  private readonly homeDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly shell: HostAccountShell;

  constructor(options: ShellExecutorOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? homedir();
    if (!this.homeDirectory) {
      throw new Error("Unable to determine the Client account Home directory");
    }
    this.environment = commandEnvironment(options.environment ?? process.env);
    this.shell = options.shell ?? hostAccountShell();
  }

  async execute(
    command: string,
    cwd: string | undefined,
    hooks: CommandHooks,
    signal?: AbortSignal,
  ): Promise<RunningCommand> {
    assertCommandCanStart(signal);
    const workingDirectory = await realpath(cwd ?? this.homeDirectory);
    assertCommandCanStart(signal);
    return spawnCommand(
      this.shell.program,
      this.shell.argsForCommand(command),
      workingDirectory,
      this.environment,
      hooks,
      this.shell.windowsVerbatimArguments ?? false,
    );
  }
}

export function assertCommandCanStart(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Command was cancelled before process start");
  }
}

function spawnCommand(
  program: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  hooks: CommandHooks,
  windowsVerbatimArguments: boolean,
): RunningCommand {
  const child = spawn(program, args, {
    cwd,
    env: environment,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(process.platform === "win32" && windowsVerbatimArguments
      ? { windowsVerbatimArguments: true }
      : {}),
  });
  child.stdout.on("data", (chunk: Buffer) => hooks.stdout(chunk));
  child.stderr.on("data", (chunk: Buffer) => hooks.stderr(chunk));

  const done = new Promise<{ exitCode: number | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode }));
  });
  let closed = false;
  void done.then(
    () => { closed = true; },
    () => { closed = true; },
  );
  let cancellation: Promise<void> | undefined;
  const cancel = async (): Promise<void> => {
    const pid = child.pid;
    if (!pid || closed) return;
    cancellation ??= terminateProcessTree(pid, done);
    await cancellation;
  };
  return { cancel, done };
}

async function terminateProcessTree(
  pid: number,
  done: Promise<{ exitCode: number | null }>,
): Promise<void> {
  if (process.platform === "win32") {
    const killer = spawn(windowsTaskkillPath(), ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      const watchdog = setTimeout(() => {
        killer.kill("SIGKILL");
        reject(new Error("taskkill timed out while terminating the process tree"));
      }, 4_000);
      watchdog.unref();
      killer.once("error", (error) => {
        clearTimeout(watchdog);
        reject(error);
      });
      killer.once("close", (exitCode) => {
        clearTimeout(watchdog);
        if (exitCode === 0) resolve();
        else reject(new Error(`taskkill exited with status ${exitCode ?? "unknown"}`));
      });
    });
    if (await processExited(done, 4_000)) return;
    throw new Error("Unable to confirm Windows process-tree termination");
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
}

function windowsTaskkillPath(): string {
  const windowsDirectory = process.env.SystemRoot;
  if (!windowsDirectory || !win32.isAbsolute(windowsDirectory)) {
    throw new Error("Unable to locate the Windows system directory safely");
  }
  return win32.join(windowsDirectory, "System32", "taskkill.exe");
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
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
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

async function processExited(
  done: Promise<{ exitCode: number | null }>,
  timeoutMilliseconds: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMilliseconds);
    timeout.unref();
    void done.then(
      () => { clearTimeout(timeout); resolve(true); },
      () => { clearTimeout(timeout); resolve(true); },
    );
  });
}

function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
