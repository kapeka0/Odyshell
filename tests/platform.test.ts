import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@odyshell/protocol";
import { PendingCommand } from "../apps/client/src/command-control.js";
import {
  adjustedTaskDeadline,
  ClientMessageBuffer,
  commandTimeoutMilliseconds,
  inspectClientRuntime,
  terminalMachineClose,
  terminateLocalAuthority,
} from "../apps/client/src/index.js";
import { CommandJournal } from "../apps/client/src/journal.js";
import {
  clientConfigPathForProfile,
  hostAccountShell,
} from "../apps/client/src/platform.js";
import {
  assertLocalAuthorityNotQuarantined,
  localAuthorityQuarantinePath,
  quarantineLocalAuthority,
} from "../apps/client/src/quarantine.js";
import {
  MachineLifecycleQueue,
  socketReadyForAuthentication,
} from "../apps/server/src/gateway.js";
import {
  activateLinuxUserService,
  linuxServiceNameForConfig,
  linuxUserServicePath,
  renderLinuxUserService,
} from "../apps/client/src/service.js";

describe("Task-native Client boundary", () => {
  it("uses Server time within the skew window and rejects unsafe clocks", () => {
    const localNow = Date.parse("2026-07-31T10:00:20.000Z");
    expect(adjustedTaskDeadline(
      "2026-07-31T10:05:00.000Z",
      "2026-07-31T10:00:00.000Z",
      localNow,
    ).toISOString()).toBe("2026-07-31T10:05:20.000Z");
    expect(() => adjustedTaskDeadline(
      "2026-07-31T10:05:00.000Z",
      "2026-07-31T09:59:00.000Z",
      localNow,
    )).toThrow("outside the allowed Task skew");
  });

  it("bounds Commands by Local Policy and remaining Task authority", () => {
    const now = Date.parse("2026-08-04T10:00:00.000Z");
    expect(commandTimeoutMilliseconds(5, 30, new Date(now + 10_000), now)).toBe(5_000);
    expect(commandTimeoutMilliseconds(120, 30, new Date(now + 60_000), now)).toBe(0);
    expect(commandTimeoutMilliseconds(30, 30, new Date(now + 10_000), now)).toBe(10_000);
    expect(commandTimeoutMilliseconds(30, 30, new Date(now), now)).toBe(0);
  });

  it("bounds disconnected output and upgrades the retained completion", () => {
    const discarded: string[] = [];
    const buffer = new ClientMessageBuffer(2, 8, (commandId) => discarded.push(commandId));
    expect(buffer.enqueue({
      type: "command.output",
      commandId: "command-a",
      sequence: 0,
      stream: "stdout",
      dataBase64: Buffer.from("first").toString("base64"),
    })).toEqual({ accepted: true });
    expect(buffer.enqueue({
      type: "command.output",
      commandId: "command-a",
      sequence: 1,
      stream: "stderr",
      dataBase64: Buffer.from("second").toString("base64"),
    })).toEqual({ accepted: false });
    expect(discarded).toEqual(["command-a"]);
    expect(buffer.enqueue({
      type: "command.completed",
      commandId: "command-a",
      status: "succeeded",
      exitCode: 0,
      outputTruncated: false,
      at: new Date(1).toISOString(),
    })).toEqual({ accepted: true });
    buffer.markOutputTruncated("command-a");
    expect(buffer.drain()).toEqual([
      expect.objectContaining({ type: "command.output", sequence: 0 }),
      expect.objectContaining({
        type: "command.completed",
        outputTruncated: true,
        error: "Command output is incomplete",
      }),
    ]);
  });

  it("marks evicted output before admitting control messages", () => {
    let outputVisibleWhenMarked = false;
    let buffer: ClientMessageBuffer;
    buffer = new ClientMessageBuffer(1, 1024, () => {
      outputVisibleWhenMarked = buffer.peek()?.type === "command.output";
    });
    buffer.enqueue({
      type: "command.output",
      commandId: "command-a",
      sequence: 0,
      stream: "stdout",
      dataBase64: Buffer.from("output").toString("base64"),
    });
    expect(buffer.enqueue({
      type: "command.completed",
      commandId: "command-a",
      status: "succeeded",
      exitCode: 0,
      outputTruncated: false,
      at: new Date(1).toISOString(),
    })).toEqual({ accepted: true, truncatedCommandId: "command-a" });
    expect(outputVisibleWhenMarked).toBe(true);
    expect(buffer.peek()).toMatchObject({
      type: "command.completed",
      outputTruncated: true,
    });
  });

  it("remembers cancellation that arrives before process registration", async () => {
    const pending = new PendingCommand("task-a");
    let cancelled = false;
    const cancellation = pending.cancel();
    pending.attach({
      cancel: async () => { cancelled = true; },
      done: Promise.resolve({ exitCode: null }),
    });
    await cancellation;
    expect(cancelled).toBe(true);
    expect(pending.cancelRequested).toBe(true);
  });

  it("propagates cancellation failure and quarantines future restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-quarantine-"));
    try {
      const pending = new PendingCommand("task-a");
      pending.attach({
        cancel: async () => { throw new Error("sensitive process detail"); },
        done: new Promise(() => {}),
      });
      const failure = pending.waitForCancellationFailure();
      await expect(pending.cancel()).rejects.toThrow("sensitive process detail");
      await expect(failure).rejects.toThrow("sensitive process detail");
      quarantineLocalAuthority(directory);
      expect(() => assertLocalAuthorityNotQuarantined(directory)).toThrow(
        "authority_termination_unconfirmed",
      );
      expect(await readFile(localAuthorityQuarantinePath(directory), "utf8"))
        .not.toContain("sensitive process detail");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("advertises only native Host Shell execution", async () => {
    const runtime = await inspectClientRuntime();
    expect(runtime.defaultShell).toBe(hostAccountShell().program);
    expect(runtime.privilegeEscalation).toBe("none");
    expect(runtime).not.toHaveProperty("supportedCapabilities");
    expect(runtime).not.toHaveProperty("profiles");
  });

  it("uses the Task-native wire protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });

  it("serializes disconnect and reconnect state for one Machine", async () => {
    const queue = new MachineLifecycleQueue();
    const order: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const entered = new Promise<void>((resolveStarted) => { started = resolveStarted; });
    const disconnect = queue.run("machine-a", async () => {
      order.push("disconnect:start");
      started();
      await gate;
      order.push("disconnect:end");
    });
    const reconnect = queue.run("machine-a", async () => { order.push("reconnect"); });
    await entered;
    expect(order).toEqual(["disconnect:start"]);
    release();
    await Promise.all([disconnect, reconnect]);
    expect(order).toEqual(["disconnect:start", "disconnect:end", "reconnect"]);
  });

  it("does not authenticate a socket that closed while queued", async () => {
    const queue = new MachineLifecycleQueue();
    const socket: { readyState: 0 | 1 | 2 | 3 } = { readyState: 1 };
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
    const blocker = queue.run("machine-a", async () => {
      markStarted();
      await new Promise<void>((resolveBlocker) => { release = resolveBlocker; });
    });
    let activated = false;
    const authentication = queue.run("machine-a", async () => {
      if (!socketReadyForAuthentication(socket)) return;
      activated = true;
    });
    await started;
    socket.readyState = 3;
    release();
    await Promise.all([blocker, authentication]);
    expect(activated).toBe(false);
  });

  it("treats only Machine revocation as terminal transport closure", () => {
    expect(terminalMachineClose(4004)).toBe(true);
    expect(terminalMachineClose(1006)).toBe(false);
    expect(terminalMachineClose(4003)).toBe(false);
  });

  it("keeps bounded Task authority across ordinary transport reconnects", () => {
    const client = readFileSync(resolve(process.cwd(), "apps/client/src/index.ts"), "utf8");
    expect(client).toContain("const existing = this.tasks.get(message.taskId)");
    expect(client).toContain("Task retry does not match active local authority");
    expect(client).toContain("this.bufferedMessages.enqueue(message)");
    expect(client).toContain("this.reconcileJournalResults()");
    expect(client).toContain("await this.dropLocalAuthority()");
    expect(client).not.toContain("session.open");
    expect(client).not.toContain("operation.start");
    expect(client).not.toContain("filesystem");
  });

  it("fails closed when process-tree termination cannot be proved", () => {
    const client = readFileSync(resolve(process.cwd(), "apps/client/src/index.ts"), "utf8");
    const command = client.slice(
      client.indexOf("private async startCommand("),
      client.indexOf("private failCommand("),
    );
    expect(command).toContain("Promise.race([prepared.done, cancellationFailure])");
    expect(command).toContain("execution_unknown");
    expect(client).toContain("this.beginTerminalFailure(");
    expect(client).toContain("process.exit(1)");
  });

  it("terminates Commands before releasing Task state", async () => {
    const events: string[] = [];
    await terminateLocalAuthority(
      [async () => { events.push("command:cancelled"); }],
      [async () => { events.push("task:closed"); }],
    );
    expect(events).toEqual(["command:cancelled", "task:closed"]);
  });

  it("recovers interrupted Commands as execution_unknown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-journal-recovery-"));
    const path = join(directory, "commands.sqlite");
    try {
      const before = new CommandJournal(path);
      before.receive("running-command");
      before.markRunning("running-command");
      before.markOutputTruncated("running-command");
      before.receive("received-command");
      before.close();

      const after = new CommandJournal(path);
      expect(after.recoverInterrupted()).toBe(2);
      expect(after.result("running-command")).toMatchObject({
        status: "execution_unknown",
        error: "Client restarted before it could prove the Command outcome",
        outputTruncated: true,
      });
      expect(after.resultsForReconciliation().map((entry) => entry.commandId)).toEqual([
        "running-command",
        "received-command",
      ]);
      after.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks unconfirmed output conservatively after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-journal-output-"));
    const path = join(directory, "commands.sqlite");
    try {
      const before = new CommandJournal(path);
      before.receive("command-a");
      before.markRunning("command-a");
      before.markOutputUnconfirmed("command-a");
      before.complete("command-a", {
        status: "succeeded",
        exitCode: 0,
        outputTruncated: false,
      });
      before.close();

      const after = new CommandJournal(path);
      expect(after.recoverInterrupted()).toBe(0);
      expect(after.result("command-a")).toMatchObject({
        status: "succeeded",
        outputTruncated: true,
      });
      after.acknowledge("command-a");
      expect(after.resultsForReconciliation()).toEqual([]);
      after.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses isolated Linux systemd services for Client identities", async () => {
    expect(linuxUserServicePath("/home/ada", {})).toBe(
      "/home/ada/.config/systemd/user/odyshell-client.service",
    );
    const first = linuxServiceNameForConfig("/home/ada/one/client.json");
    const second = linuxServiceNameForConfig("/home/ada/two/client.json");
    expect(first).not.toBe(second);
    const unit = renderLinuxUserService({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/odyshell/ods.js",
      configPath: "/home/ada/.config/odyshell/client.json",
    });
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("NoNewPrivileges=true");

    const calls: string[][] = [];
    await activateLinuxUserService("odyshell-client-test.service", async (args) => {
      calls.push(args);
    });
    expect(calls.at(-1)).toEqual(["is-active", "--quiet", "odyshell-client-test.service"]);
  });

  it("uses a deterministic path for each named Client Profile", () => {
    expect(clientConfigPathForProfile("customer", "linux", "/home/ada", {})).toBe(
      "/home/ada/.config/odyshell/clients/customer/client.json",
    );
    expect(() => clientConfigPathForProfile("../escape", "linux", "/home/ada", {}))
      .toThrow("Client Profile name");
  });
});
