import { mkdtemp, realpath, rm } from "node:fs/promises";
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
