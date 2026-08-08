import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCommandCanStart,
  ShellExecutor,
} from "../apps/client/src/shell-executor.js";

function nodeShell() {
  return {
    program: process.execPath,
    argsForCommand: (command: string) => ["-e", command],
  };
}

describe("ShellExecutor", () => {
  it("runs one non-interactive Command in the account Home", async () => {
    const home = await mkdtemp(join(tmpdir(), "odyshell-shell-home-"));
    try {
      const stdout: Buffer[] = [];
      const executor = new ShellExecutor({ homeDirectory: home, shell: nodeShell() });
      const running = await executor.execute(
        "process.stdout.write(process.cwd())",
        undefined,
        { stdout: (data) => stdout.push(data), stderr: () => {} },
      );
      await expect(running.done).resolves.toEqual({ exitCode: 0 });
      expect(Buffer.concat(stdout).toString()).toBe(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses an explicit existing working directory and rejects a missing one", async () => {
    const home = await mkdtemp(join(tmpdir(), "odyshell-shell-cwd-"));
    const cwd = join(home, "work");
    await mkdir(cwd);
    try {
      const stdout: Buffer[] = [];
      const executor = new ShellExecutor({ homeDirectory: home, shell: nodeShell() });
      const running = await executor.execute(
        "process.stdout.write(process.cwd())",
        cwd,
        { stdout: (data) => stdout.push(data), stderr: () => {} },
      );
      await running.done;
      expect(Buffer.concat(stdout).toString()).toBe(cwd);
      await expect(executor.execute(
        "process.exit(0)",
        join(home, "missing"),
        { stdout: () => {}, stderr: () => {} },
      )).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("passes only the allowlisted Client environment", async () => {
    const home = await mkdtemp(join(tmpdir(), "odyshell-shell-env-"));
    try {
      const stdout: Buffer[] = [];
      const executor = new ShellExecutor({
        homeDirectory: home,
        shell: nodeShell(),
        environment: { PATH: "safe-path", ODYSHELL_SECRET: "must-not-leak" },
      });
      const running = await executor.execute(
        "process.stdout.write(JSON.stringify({path:process.env.PATH,secret:process.env.ODYSHELL_SECRET??null}))",
        undefined,
        { stdout: (data) => stdout.push(data), stderr: () => {} },
      );
      await running.done;
      expect(JSON.parse(Buffer.concat(stdout).toString())).toEqual({
        path: "safe-path",
        secret: null,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not expose caller-controlled stdin", async () => {
    const home = await mkdtemp(join(tmpdir(), "odyshell-shell-stdin-"));
    try {
      const stdout: Buffer[] = [];
      const executor = new ShellExecutor({ homeDirectory: home, shell: nodeShell() });
      const running = await executor.execute(
        "let n=0;process.stdin.on('data',d=>n+=d.length);process.stdin.on('end',()=>process.stdout.write(String(n)))",
        undefined,
        { stdout: (data) => stdout.push(data), stderr: () => {} },
      );
      await running.done;
      expect(Buffer.concat(stdout).toString()).toBe("0");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an aborted Command before spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => assertCommandCanStart(controller.signal)).toThrow(
      "cancelled before process start",
    );
  });

  it("cancels a running process and confirms its exit", async () => {
    const home = await mkdtemp(join(tmpdir(), "odyshell-shell-cancel-"));
    try {
      const executor = new ShellExecutor({ homeDirectory: home, shell: nodeShell() });
      const running = await executor.execute(
        "setInterval(()=>{},1000)",
        undefined,
        { stdout: () => {}, stderr: () => {} },
      );
      await running.cancel();
      await running.done;
      await expect(running.cancel()).resolves.toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
