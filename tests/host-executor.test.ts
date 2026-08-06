import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import type { HostClientProfile, OperationAction } from "@odyshell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OperationHooks, RunningSession } from "../apps/client/src/executor.js";
import { HostExecutor } from "../apps/client/src/host-executor.js";

describe("HostExecutor", () => {
  let workspace: string;
  let executor: HostExecutor;
  let session: RunningSession;
  const profile = (_root: string): HostClientProfile => ({
    runner: "host",
    maxSessionTtlSeconds: 300,
    maxConcurrentSessions: 2,
    maxConcurrentOperations: 4,
    maxOperationTimeoutSeconds: 60,
    maxOutputBytes: 1024 * 1024,
    capabilities: [
      "process.exec",
      "host.shell",
      "fs.write",
      "fs.list",
      "fs.read",
      "fs.remove",
      "fs.search",
    ],
  });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "odyshell-host-"));
    executor = new HostExecutor({ homeDirectory: workspace });
    session = await executor.openSession(
      crypto.randomUUID(),
      profile(workspace),
      [
        "process.exec",
        "host.shell",
        "fs.write",
        "fs.list",
        "fs.read",
        "fs.remove",
        "fs.search",
      ],
      undefined,
      new Date(Date.now() + 60_000),
      () => {},
    );
  });

  afterEach(async () => {
    await executor.closeSession(session);
    await rm(workspace, { recursive: true, force: true });
  });

  it("executes a structured process relative to the account Home", async () => {
    const output: Buffer[] = [];
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "process.exec",
        program: process.execPath,
        args: ["-e", "process.stdout.write(process.cwd())"],
        cwd: ".",
      },
      hooks({ stdout: (data) => output.push(data) }),
    );

    expect((await running.done).exitCode).toBe(0);
    expect(await realpath(Buffer.concat(output).toString())).toBe(
      await realpath(resolve(workspace)),
    );
  });

  it("runs each host shell command in a fresh login shell rooted at the account Home", async () => {
    const environmentKey = `ODYSHELL_HOST_SHELL_${crypto.randomUUID().replaceAll("-", "")}`;
    const inheritedSecretKey = `ODYSHELL_SECRET_${crypto.randomUUID().replaceAll("-", "")}`;
    const input = Buffer.from("input from the operation");
    await executor.closeSession(session);
    executor = new HostExecutor({
      homeDirectory: workspace,
      environment: { ...process.env, [inheritedSecretKey]: "must-not-inherit" },
      shell: {
        program: process.execPath,
        argsForCommand: (command) => ["-e", command],
      },
    });
    session = await executor.openSession(
      crypto.randomUUID(),
      profile(workspace),
      ["host.shell"],
      undefined,
      new Date(Date.now() + 60_000),
      () => {},
    );
    const firstOutput: Buffer[] = [];
    const firstError: Buffer[] = [];
    const first = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "host.shell",
        command: [
          "const chunks = []",
          "process.stdin.on('data', (chunk) => chunks.push(chunk))",
          `process.stdin.on('end', () => process.stdout.write(JSON.stringify({ cwd: process.cwd(), environment: process.env[${JSON.stringify(environmentKey)}], inheritedSecret: process.env[${JSON.stringify(inheritedSecretKey)}], stdin: Buffer.concat(chunks).toString() })))`,
        ].join(";"),
        cwd: ".",
        env: { [environmentKey]: "temporary" },
        stdinBase64: input.toString("base64"),
      },
      hooks({
        stdout: (data) => firstOutput.push(data),
        stderr: (data) => firstError.push(data),
      }),
    );

    expect(
      (await first.done).exitCode,
      Buffer.concat(firstError).toString(),
    ).toBe(0);
    const result = JSON.parse(Buffer.concat(firstOutput).toString()) as {
      cwd: string;
      environment: string;
      inheritedSecret?: string;
      stdin: string;
    };
    expect(await realpath(result.cwd)).toBe(await realpath(workspace));
    expect(result.environment).toBe("temporary");
    expect(result.inheritedSecret).toBeUndefined();
    expect(result.stdin).toBe(input.toString());

    const secondOutput: Buffer[] = [];
    const second = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "host.shell",
        command: `process.stdout.write(process.env[${JSON.stringify(environmentKey)}] ?? 'missing')`,
        cwd: ".",
        env: {},
      },
      hooks({ stdout: (data) => secondOutput.push(data) }),
    );

    expect((await second.done).exitCode).toBe(0);
    expect(Buffer.concat(secondOutput).toString()).toBe("missing");
  });

  it("keeps Host Shell authority after a command fails", async () => {
    await executor.closeSession(session);
    executor = new HostExecutor({
      homeDirectory: workspace,
      shell: {
        program: process.execPath,
        argsForCommand: (command) => ["-e", command],
      },
    });
    session = await executor.openSession(
      crypto.randomUUID(),
      profile(workspace),
      ["host.shell"],
      undefined,
      new Date(Date.now() + 60_000),
      () => {},
    );

    const failed = await executor.execute(
      crypto.randomUUID(),
      session,
      { kind: "host.shell", command: "process.exit(7)", cwd: ".", env: {} },
      hooks(),
    );
    expect((await failed.done).exitCode).toBe(7);

    const output: Buffer[] = [];
    const corrected = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "host.shell",
        command: "process.stdout.write('recovered')",
        cwd: ".",
        env: {},
      },
      hooks({ stdout: (data) => output.push(data) }),
    );

    expect((await corrected.done).exitCode).toBe(0);
    expect(Buffer.concat(output).toString()).toBe("recovered");
  });

  it.skipIf(process.platform !== "win32")(
    "passes quoted Host Shell commands to cmd.exe without rewriting them",
    async () => {
      const output: Buffer[] = [];
      const running = await executor.execute(
        crypto.randomUUID(),
        session,
        {
          kind: "host.shell",
          command: 'echo "quoted value"',
          cwd: ".",
          env: {},
        },
        hooks({ stdout: (data) => output.push(data) }),
      );

      expect((await running.done).exitCode).toBe(0);
      expect(Buffer.concat(output).toString().trim()).toBe('"quoted value"');
    },
  );

  it.skipIf(process.platform !== "win32")(
    "lets explicit environment values override base keys case-insensitively",
    async () => {
      await executor.closeSession(session);
      executor = new HostExecutor({
        homeDirectory: workspace,
        environment: { ...process.env, PATH: "base-value" },
      });
      session = await executor.openSession(
        crypto.randomUUID(),
        profile(workspace),
        ["host.shell"],
        undefined,
        new Date(Date.now() + 60_000),
        () => {},
      );
      const output: Buffer[] = [];
      const running = await executor.execute(
        crypto.randomUUID(),
        session,
        {
          kind: "host.shell",
          command: "echo %PATH%",
          cwd: ".",
          env: { Path: "explicit-value" },
        },
        hooks({ stdout: (data) => output.push(data) }),
      );

      expect((await running.done).exitCode).toBe(0);
      expect(Buffer.concat(output).toString().trim()).toBe("explicit-value");
    },
  );

  it("rejects malformed or oversized host shell stdin at the Client boundary", async () => {
    await expect(
      executor.execute(
        crypto.randomUUID(),
        session,
        {
          kind: "host.shell",
          command: "echo ignored",
          cwd: ".",
          env: {},
          stdinBase64: "not base64",
        },
        hooks(),
      ),
    ).rejects.toThrow("valid standard base64");

    await expect(
      executor.execute(
        crypto.randomUUID(),
        session,
        {
          kind: "host.shell",
          command: "echo ignored",
          cwd: ".",
          env: {},
          stdinBase64: Buffer.alloc(1024 * 1024 + 1).toString("base64"),
        },
        hooks(),
      ),
    ).rejects.toThrow("exceeds 1 MiB");
  });

  it("does not crash when a command exits before consuming bounded stdin", async () => {
    await executor.closeSession(session);
    executor = new HostExecutor({
      homeDirectory: workspace,
      shell: {
        program: process.execPath,
        argsForCommand: () => ["-e", "process.exit(0)"],
      },
    });
    session = await executor.openSession(
      crypto.randomUUID(),
      profile(workspace),
      ["host.shell"],
      undefined,
      new Date(Date.now() + 60_000),
      () => {},
    );

    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "host.shell",
        command: "ignored by the test shell",
        cwd: ".",
        env: {},
        stdinBase64: Buffer.alloc(1024 * 1024).toString("base64"),
      },
      hooks(),
    );

    await expect(running.done).resolves.toEqual({ exitCode: 0 });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  });

  it("does not spawn a Host Shell command after its preparation deadline", async () => {
    let shellInvocations = 0;
    await executor.closeSession(session);
    executor = new HostExecutor({
      homeDirectory: workspace,
      shell: {
        program: process.execPath,
        argsForCommand: () => {
          shellInvocations += 1;
          return ["-e", "process.exit(0)"];
        },
      },
    });
    session = await executor.openSession(
      crypto.randomUUID(),
      profile(workspace),
      ["host.shell"],
      undefined,
      new Date(Date.now() + 60_000),
      () => {},
    );
    const deadline = new AbortController();
    deadline.abort();

    await expect(
      executor.execute(
        crypto.randomUUID(),
        session,
        { kind: "host.shell", command: "must not run", cwd: ".", env: {} },
        hooks(),
        { signal: deadline.signal },
      ),
    ).rejects.toThrow("Operation deadline elapsed before process start");
    expect(shellInvocations).toBe(0);
  });

  it("confirms an uncooperative process is gone before cancellation resolves", async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      ready = resolveStarted;
    });
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "process.exec",
        program: process.execPath,
        args: [
          "-e",
          "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
        ],
        cwd: ".",
      },
      hooks({ stdout: () => ready() }),
    );
    await started;

    await expect(running.cancel()).resolves.toBeUndefined();
    expect(await running.done).toHaveProperty("exitCode");
    expect(running.child?.signalCode ?? running.child?.exitCode).not.toBeNull();
  }, 10_000);

  it.skipIf(process.platform === "win32")(
    "confirms descendants are gone when the process-group leader exits first",
    async () => {
      let grandchildPid: number | undefined;
      let ready!: () => void;
      const started = new Promise<void>((resolveStarted) => {
        ready = resolveStarted;
      });
      const running = await executor.execute(
        crypto.randomUUID(),
        session,
        {
          kind: "process.exec",
          program: process.execPath,
          args: [
            "-e",
            [
               "const { spawn } = require('node:child_process')",
               "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{});process.stdout.write('grandchild:'+process.pid);setInterval(()=>{},1000)`], { stdio: ['ignore', 'inherit', 'inherit'] })",
               "child.unref()",
               "setTimeout(() => process.exit(0), 50)",
            ].join(";"),
          ],
          cwd: ".",
        },
        hooks({
          stdout: (data) => {
            const match = data.toString().match(/grandchild:(\d+)/u);
            if (!match) return;
            grandchildPid = Number(match[1]);
            ready();
          },
        }),
       );
       await started;
       await new Promise<void>((resolveExit) => {
         if (running.child?.exitCode !== null) resolveExit();
         else running.child?.once("exit", () => resolveExit());
       });

       await expect(running.cancel()).resolves.toBeUndefined();
       await expect(running.done).resolves.toHaveProperty("exitCode");
      expect(grandchildPid).toBeDefined();
      expect(() => process.kill(grandchildPid!, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    },
    10_000,
  );

  it("executes a scoped process from an absolute working directory", async () => {
    const absoluteCwd = await mkdtemp(join(tmpdir(), "odyshell-cwd-"));
    try {
      const canonicalCwd = await realpath(absoluteCwd);
      await executor.closeSession(session);
      session = await executor.openSession(
        crypto.randomUUID(),
        profile(workspace),
        ["process.exec"],
        {
          process: {
            programs: [{
              program: process.execPath,
              args: ["-e", "process.stdout.write(process.cwd())"],
              cwd: { path: canonicalCwd, includeDescendants: false },
            }],
          },
        },
        new Date(Date.now() + 60_000),
        () => {},
      );
      const output: Buffer[] = [];
      const running = await executor.execute(
        crypto.randomUUID(),
        session,
        {
          kind: "process.exec",
          program: process.execPath,
          args: ["-e", "process.stdout.write(process.cwd())"],
          cwd: canonicalCwd,
        },
        hooks({ stdout: (data) => output.push(data) }),
      );

      expect((await running.done).exitCode).toBe(0);
      expect(await realpath(Buffer.concat(output).toString())).toBe(
        canonicalCwd,
      );
    } finally {
      await rm(absoluteCwd, { recursive: true, force: true });
    }
  });

  it("rejects an absolute process cwd that resolves through a symlink", async () => {
    const approved = await mkdtemp(join(tmpdir(), "odyshell-cwd-approved-"));
    const outside = await mkdtemp(join(tmpdir(), "odyshell-cwd-outside-"));
    const linkedCwd = join(approved, "linked");
    try {
      await symlink(outside, linkedCwd, "junction");
      await executor.closeSession(session);
      session = await executor.openSession(
        crypto.randomUUID(),
        profile(workspace),
        ["process.exec"],
        {
          process: {
            programs: [{
              program: process.execPath,
              args: ["-e", "process.stdout.write(process.cwd())"],
              cwd: { path: linkedCwd, includeDescendants: false },
            }],
          },
        },
        new Date(Date.now() + 60_000),
        () => {},
      );

      await expect(
        executor.execute(
          crypto.randomUUID(),
          session,
          {
            kind: "process.exec",
            program: process.execPath,
            args: ["-e", "process.stdout.write(process.cwd())"],
            cwd: linkedCwd,
          },
          hooks(),
        ),
      ).rejects.toThrow("Resolved working directory differs from the approved path");
    } finally {
      await rm(approved, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("allows Host Shell to use a working directory reached through a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "odyshell-shell-cwd-"));
    const linkedCwd = join(workspace, "linked-cwd");
    try {
      await symlink(outside, linkedCwd, "junction");
      await executor.closeSession(session);
      executor = new HostExecutor({
        homeDirectory: workspace,
        shell: {
          program: process.execPath,
          argsForCommand: () => ["-e", "process.stdout.write(process.cwd())"],
        },
      });
      session = await executor.openSession(
        crypto.randomUUID(),
        profile(workspace),
        ["host.shell"],
        undefined,
        new Date(Date.now() + 60_000),
        () => {},
      );
      const output: Buffer[] = [];

      const running = await executor.execute(
        crypto.randomUUID(),
        session,
        {
          kind: "host.shell",
          command: "ignored by the test shell",
          cwd: linkedCwd,
          env: {},
        },
        hooks({ stdout: (data) => output.push(data) }),
      );

      expect((await running.done).exitCode).toBe(0);
      expect(await realpath(Buffer.concat(output).toString())).toBe(
        await realpath(outside),
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("delegates typed filesystem write, read, and search operations", async () => {
    await execute({
      kind: "fs.write",
      path: "config/package.json",
      contentBase64: Buffer.from('{"name":"demo"}').toString("base64"),
      createParents: true,
    });

    const read = await execute({ kind: "fs.read", path: "config/package.json" });
    expect(read).toBe('{"name":"demo"}');

    const search = JSON.parse(
      await execute({
        kind: "fs.search",
        path: ".",
        query: "package",
        maxResults: 10,
      }),
    ) as Array<{ path: string }>;
    expect(search).toEqual([
      expect.objectContaining({ path: "config/package.json" }),
    ]);
  });

  it("rejects filesystem reads larger than 1 MiB before returning file contents", async () => {
    await writeFile(
      join(workspace, "oversized.bin"),
      Buffer.alloc(1024 * 1024 + 1),
    );
    const result: Buffer[] = [];
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      { kind: "fs.read", path: "oversized.bin" },
      hooks({ result: (data) => result.push(data) }),
    );

    await expect(running.done).rejects.toThrow(
      "Filesystem read exceeds the 1 MiB limit",
    );
    expect(result).toEqual([]);
  });

  it("rejects filesystem writes larger than 1 MiB before changing the tree", async () => {
    const result: Buffer[] = [];
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "fs.write",
        path: "oversized/child.bin",
        contentBase64: Buffer.alloc(1024 * 1024 + 1).toString("base64"),
        createParents: true,
      },
      hooks({ result: (data) => result.push(data) }),
    );

    await expect(running.done).rejects.toThrow(
      "Filesystem write exceeds the 1 MiB limit",
    );
    await expect(lstat(join(workspace, "oversized"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result).toEqual([]);
  });

  it("rejects filesystem listings that exceed 1,000 entries", async () => {
    const directory = join(workspace, "many-entries");
    await mkdir(directory);
    await populateDirectory(directory, 1_001);
    const result: Buffer[] = [];
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      { kind: "fs.list", path: "many-entries" },
      hooks({ result: (data) => result.push(data) }),
    );

    await expect(running.done).rejects.toThrow(
      "Filesystem list exceeds the 1,000-entry limit",
    );
    expect(result).toEqual([]);
  });

  it("bounds filesystem search work even when no result matches", async () => {
    const directory = join(workspace, "search-nodes");
    await mkdir(directory);
    await populateDirectory(directory, 2_049);
    const result: Buffer[] = [];
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "fs.search",
        path: "search-nodes",
        query: "does-not-match",
        maxResults: 1,
      },
      hooks({ result: (data) => result.push(data) }),
    );

    await expect(running.done).rejects.toThrow(
      "Filesystem search exceeds the 2,048-node limit",
    );
    expect(result).toEqual([]);
  });

  it("rejects filesystem searches deeper than 32 directories", async () => {
    let directory = join(workspace, "deep-search");
    await mkdir(directory);
    for (let depth = 0; depth <= 32; depth += 1) {
      directory = join(directory, `level-${depth}`);
      await mkdir(directory);
    }
    const result: Buffer[] = [];
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "fs.search",
        path: "deep-search",
        query: "does-not-match",
        maxResults: 1,
      },
      hooks({ result: (data) => result.push(data) }),
    );

    await expect(running.done).rejects.toThrow(
      "Filesystem search exceeds the 32-directory depth limit",
    );
    expect(result).toEqual([]);
  });

  it("rejects recursive filesystem removal before changing the tree", async () => {
    const root = join(workspace, "recursive-removal");
    await mkdir(root);
    const file = join(root, "file.txt");
    await writeFile(file, "keep me");
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "fs.remove",
        path: "recursive-removal",
        recursive: true,
      } as unknown as OperationAction,
      hooks(),
    );

    await expect(running.done).rejects.toThrow(
      "Recursive filesystem removal is unavailable",
    );
    await expect(lstat(file)).resolves.toBeDefined();
  });

  it("removes individual files and empty directories", async () => {
    const file = join(workspace, "remove-file.txt");
    const directory = join(workspace, "remove-empty-directory");
    await writeFile(file, "remove me");
    await mkdir(directory);

    for (const path of ["remove-file.txt", "remove-empty-directory"]) {
      const running = await executor.execute(
        crypto.randomUUID(),
        session,
        { kind: "fs.remove", path, recursive: false },
        hooks(),
      );
      await expect(running.done).resolves.toEqual({ exitCode: 0 });
    }
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("observes filesystem write cancellation before creating parents", async () => {
    const deadline = new AbortController();
    const result: Buffer[] = [];
    const preparation = executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "fs.write",
        path: "cancelled/child.txt",
        contentBase64: Buffer.from("must not be written").toString("base64"),
        createParents: true,
      },
      hooks({ result: (data) => result.push(data) }),
      { signal: deadline.signal },
    );
    deadline.abort();
    const running = await preparation;

    await expect(running.done).resolves.toEqual({ exitCode: null });
    await expect(lstat(join(workspace, "cancelled"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result).toEqual([]);
  });

  it("stops an in-flight filesystem operation when its deadline is revoked", async () => {
    const deadline = new AbortController();
    const result: Buffer[] = [];
    const preparation = executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "fs.search",
        path: ".",
        query: "does-not-match",
        maxResults: 1,
      },
      hooks({ result: (data) => result.push(data) }),
      { signal: deadline.signal },
    );
    deadline.abort();
    const running = await preparation;

    await expect(running.done).resolves.toEqual({ exitCode: null });
    expect(result).toEqual([]);
  });

  it("waits for in-flight filesystem work to stop when its Session closes", async () => {
    const directory = join(workspace, "revoked-search");
    await mkdir(directory);
    await populateDirectory(directory, 1_000);
    const result: Buffer[] = [];
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "fs.search",
        path: "revoked-search",
        query: "does-not-match",
        maxResults: 1,
      },
      hooks({ result: (data) => result.push(data) }),
    );

    await executor.closeSession(session);

    await expect(running.done).resolves.toEqual({ exitCode: null });
    expect(result).toEqual([]);
  });

  it("enforces typed Session restrictions again on the Client", async () => {
    await executor.closeSession(session);
    session = await executor.openSession(
      crypto.randomUUID(),
      profile(workspace),
      ["process.exec", "fs.read"],
      {
        filesystem: {
          paths: [{ path: "config", includeDescendants: true }],
        },
        process: {
          programs: [
            {
              program: process.execPath,
              args: ["-e", "process.stdout.write('safe')"],
              cwd: { path: ".", includeDescendants: false },
            },
          ],
        },
      },
      new Date(Date.now() + 60_000),
      () => {},
    );

    await expect(
      executor.execute(
        crypto.randomUUID(),
        session,
        { kind: "fs.read", path: "secrets.env" },
        hooks(),
      ),
    ).rejects.toThrow("path_scope_denied");
    await expect(
      executor.execute(
        crypto.randomUUID(),
        session,
        {
          kind: "process.exec",
          program: process.execPath,
          args: ["-e", "process.stdout.write('safe'); process.exit(1)"],
          cwd: ".",
        },
        hooks(),
      ),
    ).rejects.toThrow("program_scope_denied");
  });

  it("rejects a symlink that resolves outside the account Home", async () => {
    const outside = await mkdtemp(join(tmpdir(), "odyshell-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(outside, join(workspace, "linked"), "junction");
      await expect(
        execute({ kind: "fs.read", path: "linked/secret.txt" }),
      ).rejects.toThrow("Resolved path escapes the account Home");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a relative scope rooted at a symlink inside the account Home", async () => {
    const privateDirectory = join(workspace, "private");
    await mkdir(privateDirectory);
    await writeFile(join(privateDirectory, "secret.txt"), "secret");
    await symlink(privateDirectory, join(workspace, "approved-link"), "junction");
    await executor.closeSession(session);
    session = await executor.openSession(
      crypto.randomUUID(),
      profile(workspace),
      ["fs.read"],
      {
        filesystem: {
          paths: [{ path: "approved-link", includeDescendants: true }],
        },
      },
      new Date(Date.now() + 60_000),
      () => {},
    );

    await expect(
      execute({ kind: "fs.read", path: "approved-link/secret.txt" }),
    ).rejects.toThrow("Relative path scope resolves through a symbolic link");
  });

  it("rejects relative writes that escape their scope through a parent symlink", async () => {
    const approved = join(workspace, "approved");
    const privateDirectory = join(workspace, "private");
    await mkdir(approved);
    await mkdir(privateDirectory);
    await symlink(privateDirectory, join(approved, "linked"), "junction");
    await executor.closeSession(session);
    session = await executor.openSession(
      crypto.randomUUID(),
      profile(workspace),
      ["fs.write"],
      {
        filesystem: {
          paths: [{ path: "approved", includeDescendants: true }],
        },
      },
      new Date(Date.now() + 60_000),
      () => {},
    );

    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "fs.write",
        path: "approved/linked/secret.txt",
        contentBase64: Buffer.from("secret").toString("base64"),
        createParents: true,
      },
      hooks(),
    );
    await expect(running.done).rejects.toThrow(
      "Resolved path escapes the approved relative scope",
    );
    await expect(lstat(join(privateDirectory, "secret.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reads an absolute path when the Session grants unrestricted filesystem access", async () => {
    const outside = await mkdtemp(join(tmpdir(), "odyshell-unrestricted-"));
    try {
      const approvedPath = join(outside, "interfaces");
      await writeFile(approvedPath, "network config");

      const result: Buffer[] = [];
      const running = await executor.execute(
        crypto.randomUUID(),
        session,
        { kind: "fs.read", path: approvedPath },
        hooks({ result: (data) => result.push(data) }),
      );

      expect((await running.done).exitCode).toBe(0);
      expect(Buffer.concat(result).toString()).toBe("network config");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects unrestricted filesystem access when local policy narrows paths", async () => {
    await executor.closeSession(session);
    await expect(
      executor.openSession(
        crypto.randomUUID(),
        {
          ...profile(workspace),
          restrictions: {
            filesystem: {
              paths: [{ path: "config", includeDescendants: true }],
            },
          },
        },
        ["fs.read"],
        {},
        new Date(Date.now() + 60_000),
        () => {},
      ),
    ).rejects.toThrow("restriction_widening");
  });

  it("reads an exact absolute path only when the local Session grants it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "odyshell-absolute-"));
    try {
      const approvedPath = join(outside, "interfaces");
      const deniedPath = join(outside, "shadow");
      await writeFile(approvedPath, "network config");
      await writeFile(deniedPath, "denied");
      await executor.closeSession(session);
      session = await executor.openSession(
        crypto.randomUUID(),
        profile(workspace),
        ["fs.read"],
        {
          filesystem: {
            paths: [{ path: approvedPath, includeDescendants: false }],
          },
        },
        new Date(Date.now() + 60_000),
        () => {},
      );

      await expect(
        execute({ kind: "fs.read", path: approvedPath }),
      ).resolves.toBe("network config");
      await expect(
        executor.execute(
          crypto.randomUUID(),
          session,
          { kind: "fs.read", path: deniedPath },
          hooks(),
        ),
      ).rejects.toThrow("path_scope_denied");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects writes that escape an absolute descendant scope through a symlink", async () => {
    const approved = await mkdtemp(join(tmpdir(), "odyshell-approved-"));
    const outside = await mkdtemp(join(tmpdir(), "odyshell-outside-"));
    try {
      await symlink(outside, join(approved, "linked"), "junction");
      await executor.closeSession(session);
      session = await executor.openSession(
        crypto.randomUUID(),
        profile(workspace),
        ["fs.write"],
        {
          filesystem: {
            paths: [{ path: approved, includeDescendants: true }],
          },
        },
        new Date(Date.now() + 60_000),
        () => {},
      );

      const running = await executor.execute(
        crypto.randomUUID(),
        session,
        {
          kind: "fs.write",
          path: join(approved, "linked", "secret.txt"),
          contentBase64: Buffer.from("secret").toString("base64"),
          createParents: true,
        },
        hooks(),
      );
      await expect(running.done).rejects.toThrow(
        "Resolved path escapes the approved absolute scope",
      );
    } finally {
      await rm(approved, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects an exact absolute write whose parent resolves through a symlink", async () => {
    const approved = await mkdtemp(join(tmpdir(), "odyshell-exact-approved-"));
    const outside = await mkdtemp(join(tmpdir(), "odyshell-exact-outside-"));
    const linked = join(approved, "linked");
    const requestedPath = join(linked, "secret.txt");
    try {
      await symlink(outside, linked, "junction");
      await executor.closeSession(session);
      session = await executor.openSession(
        crypto.randomUUID(),
        profile(workspace),
        ["fs.write"],
        {
          filesystem: {
            paths: [{ path: requestedPath, includeDescendants: false }],
          },
        },
        new Date(Date.now() + 60_000),
        () => {},
      );

      const running = await executor.execute(
        crypto.randomUUID(),
        session,
        {
          kind: "fs.write",
          path: requestedPath,
          contentBase64: Buffer.from("secret").toString("base64"),
          createParents: true,
        },
        hooks(),
      );
      await expect(running.done).rejects.toThrow(
        "Resolved path differs from the approved absolute path",
      );
    } finally {
      await rm(approved, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("waits for active process cleanup when a Session closes", async () => {
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "process.exec",
        program: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: ".",
      },
      hooks(),
    );
    expect(running.child?.pid).toBeTypeOf("number");

    await executor.closeSession(session);

    await running.done;
    expect(running.child?.exitCode ?? running.child?.signalCode).not.toBeNull();
  });

  async function execute(action: OperationAction): Promise<string> {
    const result: Buffer[] = [];
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      action,
      hooks({ result: (data) => result.push(data) }),
    );
    expect((await running.done).exitCode).toBe(0);
    return Buffer.concat(result).toString();
  }
});

function hooks(
  overrides: Partial<OperationHooks> = {},
): OperationHooks {
  return {
    stdout: () => {},
    stderr: () => {},
    result: () => {},
    ...overrides,
  };
}

async function populateDirectory(
  directory: string,
  entries: number,
): Promise<void> {
  await Promise.all(
    Array.from({ length: entries }, (_, index) =>
      writeFile(
        join(directory, `entry-${index.toString().padStart(4, "0")}.txt`),
        "",
      ),
    ),
  );
}
