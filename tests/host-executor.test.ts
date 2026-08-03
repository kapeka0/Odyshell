import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  const profile = (root: string): HostClientProfile => ({
    runner: "host",
    workspaceRoot: root,
    maxSessionTtlSeconds: 300,
    maxConcurrentSessions: 2,
    maxOutputBytes: 1024 * 1024,
    capabilities: ["process.exec", "fs.write", "fs.read", "fs.search"],
  });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "odyshell-host-"));
    executor = new HostExecutor();
    session = await executor.openSession(
      crypto.randomUUID(),
      profile(workspace),
      ["process.exec", "fs.write", "fs.read", "fs.search"],
      undefined,
      new Date(Date.now() + 60_000),
      () => {},
    );
  });

  afterEach(async () => {
    await executor.closeSession(session);
    await rm(workspace, { recursive: true, force: true });
  });

  it("executes a structured process in the configured host workspace", async () => {
    const output: Buffer[] = [];
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "process.exec",
        program: process.execPath,
        args: ["-e", "process.stdout.write(process.cwd())"],
        cwd: ".",
        env: {},
      },
      hooks({ stdout: (data) => output.push(data) }),
    );

    expect((await running.done).exitCode).toBe(0);
    expect(await realpath(Buffer.concat(output).toString())).toBe(
      await realpath(resolve(workspace)),
    );
  });

  it("executes a scoped process from an absolute working directory", async () => {
    const absoluteCwd = await mkdtemp(join(tmpdir(), "odyshell-cwd-"));
    try {
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
              cwd: { path: absoluteCwd, includeDescendants: false },
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
          cwd: absoluteCwd,
          env: {},
        },
        hooks({ stdout: (data) => output.push(data) }),
      );

      expect((await running.done).exitCode).toBe(0);
      expect(await realpath(Buffer.concat(output).toString())).toBe(
        await realpath(absoluteCwd),
      );
    } finally {
      await rm(absoluteCwd, { recursive: true, force: true });
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
          env: {},
        },
        hooks(),
      ),
    ).rejects.toThrow("program_scope_denied");
    await expect(
      executor.execute(
        crypto.randomUUID(),
        session,
        {
          kind: "process.exec",
          program: process.execPath,
          args: ["-e", "process.stdout.write('safe')"],
          cwd: ".",
          env: { PATH: workspace },
        },
        hooks(),
      ),
    ).rejects.toThrow("not allowed by Session policy");
    await expect(
      executor.execute(
        crypto.randomUUID(),
        session,
        {
          kind: "process.exec",
          program: process.execPath,
          args: ["-e", "process.stdout.write('safe')"],
          cwd: ".",
          env: { BASH_ENV: "attacker-controlled" },
        },
        hooks(),
      ),
    ).rejects.toThrow("not allowed by Session policy");
  });

  it("rejects a symlink that resolves outside the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "odyshell-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(outside, join(workspace, "linked"), "junction");
      await expect(
        execute({ kind: "fs.read", path: "linked/secret.txt" }),
      ).rejects.toThrow("Resolved path escapes the configured workspace");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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

  it("waits for active process cleanup when a Session closes", async () => {
    const running = await executor.execute(
      crypto.randomUUID(),
      session,
      {
        kind: "process.exec",
        program: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: ".",
        env: {},
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
