import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@odyshell/protocol";
import {
  clientConfigPathFor,
  clientConfigPathForProfile,
  containerUser,
  hostAccountShell,
  hostPlatform,
} from "../apps/client/src/platform.js";
import { parseDockerRuntime } from "../apps/client/src/docker-runner.js";
import { OperationJournal } from "../apps/client/src/journal.js";
import {
  adjustedSessionDeadline,
  ClientMessageBuffer,
  inspectClientRuntime,
  operationTimeoutMilliseconds,
  reportedPrivilegeEscalation,
  terminalMachineClose,
  supportedCapabilitiesForRunners,
  terminateLocalAuthority,
} from "../apps/client/src/index.js";
import { PendingOperation } from "../apps/client/src/operation-control.js";
import {
  assertLocalAuthorityNotQuarantined,
  localAuthorityQuarantinePath,
  quarantineLocalAuthority,
} from "../apps/client/src/quarantine.js";
import { SERVER_HTTP_BODY_LIMIT_BYTES } from "../apps/server/src/http-limits.js";
import { clientCompatibility } from "../apps/server/src/compatibility.js";
import {
  MachineLifecycleQueue,
  socketReadyForAuthentication,
} from "../apps/server/src/gateway.js";
import {
  activateMacLaunchAgent,
  activateLinuxUserService,
  linuxServiceNameForConfig,
  linuxUserServicePath,
  macLaunchAgentLabelForConfig,
  macLaunchAgentPath,
  renderMacLaunchAgent,
  renderLinuxUserService,
  renderWindowsTaskAction,
  renderWindowsTaskLauncher,
  windowsTaskActionIsCurrent,
  windowsTaskLauncherPath,
  windowsTaskNameForConfig,
} from "../apps/client/src/service.js";
import {
  DEFAULT_CLOUD_SERVER_URL,
  cliConfigPathFor,
  serverUrlFor,
} from "../apps/cli/src/config.js";

describe("client platform support", () => {
  it("uses Server time within the skew window and rejects unsafe clocks", () => {
    const localNow = Date.parse("2026-07-31T10:00:20.000Z");
    expect(
      adjustedSessionDeadline(
        "2026-07-31T10:05:00.000Z",
        "2026-07-31T10:00:00.000Z",
        localNow,
      ).toISOString(),
    ).toBe("2026-07-31T10:05:20.000Z");
    expect(() =>
      adjustedSessionDeadline(
        "2026-07-31T10:05:00.000Z",
        "2026-07-31T09:59:00.000Z",
        localNow,
      ),
    ).toThrow("outside the allowed Session skew");
  });

  it("clamps Operations to both local policy and remaining Session authority", () => {
    const now = Date.parse("2026-08-04T10:00:00.000Z");
    expect(
      operationTimeoutMilliseconds(7_200, 3_600, new Date(now + 10_000), now),
    ).toBe(10_000);
    expect(
      operationTimeoutMilliseconds(120, 30, new Date(now + 60_000), now),
    ).toBe(30_000);
    expect(
      operationTimeoutMilliseconds(120, 30, new Date(now), now),
    ).toBe(0);
  });

  it("accepts the documented one MiB Host Shell stdin through HTTP", () => {
    const body = JSON.stringify({
      sessionId: crypto.randomUUID(),
      action: {
        kind: "host.shell",
        command: "process input",
        cwd: ".",
        env: {},
        stdinBase64: Buffer.alloc(1024 * 1024).toString("base64"),
      },
      timeoutSeconds: 60,
      maxOutputBytes: 1024 * 1024,
    });
    expect(Buffer.byteLength(body)).toBeLessThan(SERVER_HTTP_BODY_LIMIT_BYTES);

    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );
    expect(server).toContain("bodyLimit: SERVER_HTTP_BODY_LIMIT_BYTES");
  });

  it("buffers disconnected output within a hard bound while retaining completion", () => {
    const buffer = new ClientMessageBuffer(4, 3);
    expect(buffer.enqueue({
      type: "operation.started",
      operationId: "operation-a",
      at: new Date(0).toISOString(),
    })).toEqual({ accepted: true });
    expect(buffer.enqueue({
      type: "operation.event",
      operationId: "operation-a",
      sequence: 0,
      stream: "stdout",
      dataBase64: Buffer.from("abc").toString("base64"),
    })).toEqual({ accepted: true });
    expect(buffer.enqueue({
      type: "operation.event",
      operationId: "operation-a",
      sequence: 1,
      stream: "stdout",
      dataBase64: Buffer.from("d").toString("base64"),
    })).toEqual({ accepted: false });
    expect(buffer.enqueue({
      type: "operation.completed",
      operationId: "operation-a",
      status: "succeeded",
      exitCode: 0,
      outputTruncated: true,
      at: new Date(1).toISOString(),
    })).toEqual({ accepted: true });
    expect(buffer.drain().map((message) => message.type)).toEqual([
      "operation.started",
      "operation.event",
      "operation.completed",
    ]);
  });

  it("marks a completion truncated when retaining it evicts buffered output", () => {
    let outputVisibleWhenMarked = false;
    let buffer: ClientMessageBuffer;
    buffer = new ClientMessageBuffer(2, 1024, () => {
      outputVisibleWhenMarked = buffer.peek()?.type === "operation.event";
    });
    expect(buffer.enqueue({
      type: "operation.event",
      operationId: "operation-a",
      sequence: 0,
      stream: "stdout",
      dataBase64: Buffer.from("first").toString("base64"),
    })).toEqual({ accepted: true });
    expect(buffer.enqueue({
      type: "operation.event",
      operationId: "operation-a",
      sequence: 1,
      stream: "stdout",
      dataBase64: Buffer.from("second").toString("base64"),
    })).toEqual({ accepted: true });

    expect(buffer.enqueue({
      type: "operation.completed",
      operationId: "operation-a",
      status: "succeeded",
      exitCode: 0,
      outputTruncated: false,
      at: new Date(1).toISOString(),
    })).toEqual({
      accepted: true,
      truncatedOperationId: "operation-a",
    });
    expect(outputVisibleWhenMarked).toBe(true);

    expect(buffer.drain()).toEqual([
      expect.objectContaining({
        type: "operation.event",
        sequence: 1,
      }),
      expect.objectContaining({
        type: "operation.completed",
        outputTruncated: true,
        error: "Operation output is incomplete",
      }),
    ]);
  });

  it("marks rejected output before dropping it from the bounded buffer", () => {
    const discarded: string[] = [];
    const buffer = new ClientMessageBuffer(2, 3, (operationId) => {
      discarded.push(operationId);
    });

    expect(buffer.enqueue({
      type: "operation.event",
      operationId: "operation-a",
      sequence: 0,
      stream: "stdout",
      dataBase64: Buffer.from("four").toString("base64"),
    })).toEqual({ accepted: false });
    expect(discarded).toEqual(["operation-a"]);
    expect(buffer.peek()).toBeUndefined();
  });

  it("upgrades an already buffered completion when transport output becomes uncertain", () => {
    const buffer = new ClientMessageBuffer(2, 1024);
    expect(buffer.enqueue({
      type: "operation.completed",
      operationId: "operation-a",
      status: "succeeded",
      exitCode: 0,
      outputTruncated: false,
      at: new Date(1).toISOString(),
    })).toEqual({ accepted: true });

    buffer.markOutputTruncated("operation-a");

    expect(buffer.peek()).toMatchObject({
      type: "operation.completed",
      operationId: "operation-a",
      outputTruncated: true,
    });
  });

  it("acknowledges a retained Client completion even after Server retention", () => {
    const gateway = readFileSync(
      resolve(process.cwd(), "apps/server/src/gateway.ts"),
      "utf8",
    );
    const completion = gateway.slice(
      gateway.indexOf('case "operation.completed":'),
      gateway.indexOf('case "authenticate":'),
    );

    expect(completion).toContain('type: "operation.acknowledged"');
    expect(completion).not.toMatch(
      /if \(result\) \{[\s\S]*type: "operation\.acknowledged"/u,
    );
    expect(completion).toContain("if (result?.newlyCompleted)");
  });

  it("remembers cancellation that arrives before process registration", async () => {
    const pending = new PendingOperation("session-a");
    let cancelled = false;
    const cancellation = pending.cancel();
    pending.attach({
      cancel: async () => {
        cancelled = true;
      },
      done: Promise.resolve({ exitCode: null }),
    });

    await cancellation;
    expect(cancelled).toBe(true);
    expect(pending.cancelRequested).toBe(true);
  });

  it("propagates cancellation failure and quarantines future Client restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-quarantine-"));
    try {
      const pending = new PendingOperation("session-a");
      pending.attach({
        cancel: async () => {
          throw new Error("sensitive process detail");
        },
        done: new Promise(() => {}),
      });
      const cancellationFailure = pending.waitForCancellationFailure();

      await expect(pending.cancel()).rejects.toThrow("sensitive process detail");
      await expect(cancellationFailure).rejects.toThrow("sensitive process detail");
      quarantineLocalAuthority(directory);

      expect(() => assertLocalAuthorityNotQuarantined(directory)).toThrow(
        "authority_termination_unconfirmed",
      );
      expect(
        await readFile(localAuthorityQuarantinePath(directory), "utf8"),
      ).not.toContain("sensitive process detail");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("maps Node platform names to public Odyshell platform names", () => {
    expect(hostPlatform("linux")).toBe("linux");
    expect(hostPlatform("darwin")).toBe("macos");
    expect(hostPlatform("win32")).toBe("windows");
    expect(() => hostPlatform("freebsd")).toThrow("Unsupported host platform");
  });

  it("uses the account login shell consistently for advertised host execution", () => {
    const posixShell = hostAccountShell("linux", {}, "/bin/zsh");
    expect(posixShell.program).toBe("/bin/zsh");
    expect(posixShell.argsForCommand("pwd")).toEqual(["-l", "-c", "pwd"]);

    const windowsShell = hostAccountShell(
      "win32",
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      null,
    );
    expect(windowsShell.program).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(windowsShell.argsForCommand("cd")).toEqual([
      "/d",
      "/s",
      "/c",
      "cd",
    ]);
  });

  it("reports profile capabilities without exposing local paths", async () => {
    const runtime = await inspectClientRuntime(["host"], {
      workspace: {
        runner: "host",
        maxSessionTtlSeconds: 900,
        maxConcurrentSessions: 2,
        maxConcurrentOperations: 4,
        maxOperationTimeoutSeconds: 3_600,
        maxOutputBytes: 1024 * 1024,
        capabilities: ["fs.read"],
      },
    });

    expect(runtime.profiles).toEqual([
      {
        name: "workspace",
        runner: "host",
        capabilities: ["fs.read"],
      },
    ]);
    expect(runtime.defaultShell).toBe(hostAccountShell().program);
    expect(JSON.stringify(runtime)).not.toContain("mountSource");
  });

  it("never advertises host shell authority from a Docker-only Client", () => {
    expect(supportedCapabilitiesForRunners(["docker"])).not.toContain(
      "host.shell",
    );
    expect(supportedCapabilitiesForRunners(["host"])).toContain("host.shell");
  });

  it("reports effective passwordless sudo even outside the managed service", () => {
    expect(reportedPrivilegeEscalation(false, false)).toBe("none");
    expect(reportedPrivilegeEscalation(false, true)).toBe("sudo");
    expect(reportedPrivilegeEscalation(true, false)).toBe("sudo");
  });

  it("uses the native application configuration directory", () => {
    expect(
      clientConfigPathFor("win32", "C:\\Users\\ada", {
        APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
      }),
    ).toBe("C:\\Users\\ada\\AppData\\Roaming\\Odyshell\\client.json");
    expect(clientConfigPathFor("darwin", "/Users/ada", {})).toBe(
      "/Users/ada/Library/Application Support/Odyshell/client.json",
    );
    expect(
      clientConfigPathFor("linux", "/home/ada", {
        XDG_CONFIG_HOME: "/home/ada/.config-custom",
      }),
    ).toBe("/home/ada/.config-custom/odyshell/client.json");
    expect(cliConfigPathFor("darwin", "/Users/ada", {})).toBe(
      "/Users/ada/Library/Application Support/Odyshell/config.json",
    );
  });

  it("uses Odyshell Cloud by default while preserving explicit self-hosted overrides", () => {
    expect(DEFAULT_CLOUD_SERVER_URL).toBe("https://server.odyshell.com");
    expect(serverUrlFor({}, {}, undefined)).toBe(DEFAULT_CLOUD_SERVER_URL);
    expect(
      serverUrlFor(
        { server: "https://self-hosted.example" },
        { ODYSHELL_SERVER_URL: "https://environment.example" },
        { serverUrl: "https://stored.example" },
      ),
    ).toBe("https://self-hosted.example");
    expect(
      serverUrlFor(
        {},
        { ODYSHELL_SERVER_URL: "https://environment.example" },
        { serverUrl: "https://stored.example" },
      ),
    ).toBe("https://environment.example");
  });

  it("reports additive and incompatible Client protocol versions", () => {
    expect(PROTOCOL_VERSION).toBe(4);
    expect(clientCompatibility(undefined)).toMatchObject({
      compatible: true,
      upgradeRequired: false,
      protocolVersion: null,
    });
    expect(
      clientCompatibility({
        protocolVersion: PROTOCOL_VERSION,
        clientVersion: "0.9.0",
      }),
    ).toMatchObject({
      compatible: true,
      upgradeRequired: false,
      clientVersion: "0.9.0",
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(
      clientCompatibility({
        protocolVersion: 3,
        clientVersion: "0.15.1",
      }),
    ).toMatchObject({
      compatible: false,
      upgradeRequired: true,
      protocolVersion: 3,
    });
    const gateway = readFileSync(
      resolve(process.cwd(), "apps/server/src/gateway.ts"),
      "utf8",
    );
    expect(gateway.indexOf('throw new Error("Invalid client signature")')).toBeLessThan(
      gateway.indexOf("message.protocolVersion !== PROTOCOL_VERSION"),
    );
    expect(gateway).toContain("setMachineIncompatible");
    expect(gateway).toContain("runMachineLifecycle(");
    expect(gateway).toContain("this.connections.get(state.machineId!) !== socket");
  });

  it("uses an unprivileged container identity on every host", () => {
    expect(containerUser("linux", 1001, 1002)).toBe("1001:1002");
    expect(containerUser("darwin", 501, 20)).toBe("501:20");
    expect(containerUser("win32")).toBe("1000:1000");
  });

  it("accepts Linux container engines on any host architecture", () => {
    expect(parseDockerRuntime("linux\tarm64\t28.1.0\tDocker Desktop")).toEqual({
      os: "linux",
      architecture: "arm64",
      version: "28.1.0",
      operatingSystem: "Docker Desktop",
    });
    expect(() => parseDockerRuntime("windows\tx86_64\t28.1.0\tDocker Desktop")).toThrow(
      "Linux container engine",
    );
  });

  it("serializes disconnect and reconnect state for one machine", async () => {
    const queue = new MachineLifecycleQueue();
    const order: string[] = [];
    let releaseDisconnect!: () => void;
    let markDisconnectStarted!: () => void;
    const disconnectGate = new Promise<void>((resolveGate) => {
      releaseDisconnect = resolveGate;
    });
    const disconnectStarted = new Promise<void>((resolveStarted) => {
      markDisconnectStarted = resolveStarted;
    });
    const disconnect = queue.run("machine-a", async () => {
      order.push("disconnect:start");
      markDisconnectStarted();
      await disconnectGate;
      order.push("disconnect:end");
    });
    const reconnect = queue.run("machine-a", async () => {
      order.push("reconnect");
    });

    await disconnectStarted;
    expect(order).toEqual(["disconnect:start"]);
    releaseDisconnect();
    await Promise.all([disconnect, reconnect]);
    expect(order).toEqual(["disconnect:start", "disconnect:end", "reconnect"]);
  });

  it("treats only machine revocation as a terminal transport close", () => {
    expect(terminalMachineClose(4004)).toBe(true);
    expect(terminalMachineClose(1006)).toBe(false);
    expect(terminalMachineClose(4003)).toBe(false);
  });

  it("drains queued transport messages before terminal authority cleanup", () => {
    const client = readFileSync(
      resolve(process.cwd(), "apps/client/src/index.ts"),
      "utf8",
    );
    const connect = client.slice(
      client.indexOf("private async connect()"),
      client.indexOf("private beginTerminalRevocation()"),
    );
    const revocation = client.slice(
      client.indexOf("private beginTerminalRevocation()"),
      client.indexOf("private send("),
    );
    const handler = client.slice(
      client.indexOf("private async handle("),
      client.indexOf("private async openSession("),
    );

    expect(connect).toContain("if (this.socket !== socket || this.stopped) return");
    expect(revocation.indexOf("await this.messageQueue")).toBeLessThan(
      revocation.indexOf("await this.dropLocalAuthority()"),
    );
    expect(handler).toContain("if (this.stopped) return");
  });

  it("does not activate a socket that closes while authentication is queued", async () => {
    const queue = new MachineLifecycleQueue();
    const socket: { readyState: 0 | 1 | 2 | 3 } = { readyState: 1 };
    let releaseBlocker!: () => void;
    let blockerStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      blockerStarted = resolveStarted;
    });
    const blocker = queue.run("machine-a", async () => {
      blockerStarted();
      await new Promise<void>((resolveBlocker) => {
        releaseBlocker = resolveBlocker;
      });
    });
    let activated = false;
    const authentication = queue.run("machine-a", async () => {
      if (!socketReadyForAuthentication(socket)) return;
      activated = true;
    });

    await started;
    socket.readyState = 3;
    releaseBlocker();
    await Promise.all([blocker, authentication]);

    expect(activated).toBe(false);
    const gateway = readFileSync(
      resolve(process.cwd(), "apps/server/src/gateway.ts"),
      "utf8",
    );
    expect(gateway.indexOf("state.machineId = message.machineId")).toBeLessThan(
      gateway.indexOf("await this.runMachineLifecycle(message.machineId"),
    );
    expect(gateway).toContain("if (!socketReadyForAuthentication(socket)) return");
    expect(gateway).toContain("if (current.revoked)");
    expect(gateway).toContain('socket.close(4004, "Machine access revoked")');
    expect(gateway.indexOf("await this.db.setMachineOnline")).toBeLessThan(
      gateway.indexOf("state.authenticated = true"),
    );
  });

  it("keeps bounded local authority across a transport reconnect", () => {
    const client = readFileSync(
      resolve(process.cwd(), "apps/client/src/index.ts"),
      "utf8",
    );

    expect(client).toContain("const existing = this.sessions.get(message.sessionId)");
    expect(client).toContain("sessionScopeSubsetDecision(requested, current)");
    expect(client).toContain("sessionScopeSubsetDecision(current, requested)");
    expect(client).toContain("Session retry scope does not match active local authority");
    expect(client).toContain("this.authenticated = false");
    expect(client).toContain("this.bufferedMessages.enqueue(message)");
    expect(client).toContain("this.flushBufferedMessages()");
    expect(client).toContain("this.reconcileJournalResults()");
    expect(client).toContain("this.markUnconfirmedOutputTruncated();");
    expect(client).toContain("private messageQueue = Promise.resolve()");
    expect(client).toContain("this.messageQueue = this.messageQueue");
    expect(client).toContain("return this.handle(parseServerMessage(data.toString()))");
    expect(client).not.toContain("void this.dropLocalAuthority()");
    expect(client).toContain("await this.dropLocalAuthority()");

    const deliver = client.slice(
      client.indexOf("private deliver(message:"),
      client.indexOf("private markOperationOutputTruncated("),
    );
    expect(deliver.indexOf("this.markOperationOutputUnconfirmed(")).toBeLessThan(
      deliver.indexOf("this.bufferedMessages.enqueue("),
    );
    expect(deliver.indexOf("this.markOperationOutputUnconfirmed(")).toBeLessThan(
      deliver.indexOf("this.send(message)"),
    );
  });

  it("closes superseded local authority before reopening reconnect targets", () => {
    const gateway = readFileSync(
      resolve(process.cwd(), "apps/server/src/gateway.ts"),
      "utf8",
    );
    const authentication = gateway.slice(
      gateway.indexOf("private async authenticate("),
      gateway.indexOf("private async persistMessage("),
    );
    expect(authentication.indexOf("for (const target of closeTargets)")).toBeLessThan(
      authentication.indexOf("for (const target of reconnectTargets)"),
    );
    expect(authentication).toContain("pendingOperationCancellations(");
    expect(
      authentication.indexOf("for (const operationId of pendingCancellations)"),
    ).toBeLessThan(
      authentication.indexOf("for (const target of reconnectTargets)"),
    );
    expect(authentication).toContain('type: "operation.cancel"');
  });

  it("terminates Operations and local Session state during graceful stop", async () => {
    const events: string[] = [];
    await terminateLocalAuthority(
      [async () => { events.push("operation:cancelled"); }],
      [async () => { events.push("session:closed"); }],
    );

    expect(events).toEqual(["operation:cancelled", "session:closed"]);
  });

  it("fails the Client closed when bounded process termination cannot be proved", () => {
    const client = readFileSync(
      resolve(process.cwd(), "apps/client/src/index.ts"),
      "utf8",
    );

    expect(client).toContain("Promise.race([running.done, cancellationFailure])");
    expect(client).toContain("this.beginTerminalFailure(");
    expect(client).toContain("process.exit(1)");
    expect(client).not.toContain("client.stop().finally(() => process.exit(0))");
    expect(client.match(/void this\.closeSession\(/gu)).toHaveLength(1);
    expect(client.match(/this\.closeSessionSafely\(/gu)).toHaveLength(3);
    const operation = client.slice(
      client.indexOf("private async startOperation("),
      client.indexOf("private async cancelOperation("),
    );
    expect(operation.indexOf("operationTimeoutMilliseconds(")).toBeLessThan(
      operation.indexOf("active.executor.execute("),
    );
    expect(operation).toContain("control.executionSignal()");
    expect(operation).toContain("Promise.race([executionPreparation, deadlineReached])");
    expect(operation).toContain('status: terminationUnconfirmed');
    expect(operation).toContain('? "execution_unknown"');
    const closeSession = client.slice(
      client.indexOf("private async closeSession("),
      client.indexOf("private async startOperation("),
    );
    expect(closeSession.indexOf("await closing")).toBeLessThan(
      closeSession.indexOf("this.sessions.delete(sessionId)"),
    );
  });

  it("terminalizes a cancellation that reconnects without an in-memory Operation", () => {
    const source = readFileSync("apps/client/src/index.ts", "utf8");
    const cancellation = source.slice(
      source.indexOf("private async cancelOperation("),
      source.indexOf("private sendCompletion("),
    );

    expect(source).not.toContain("cancellationsBeforeStart");
    expect(cancellation).toContain("this.journal.receive(operationId)");
    expect(cancellation).toContain(
      'status: receipt === "new" ? "cancelled" : "execution_unknown"',
    );
    expect(cancellation).toContain("this.journal.complete(operationId, result)");
    expect(cancellation).toContain("this.sendCompletion(operationId, result)");
  });

  it("marks interrupted journal entries execution_unknown and reconciles them after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-journal-recovery-"));
    const path = join(directory, "operations.sqlite");
    try {
      const beforeRestart = new OperationJournal(path);
      expect(beforeRestart.receive("running-operation")).toBe("new");
      beforeRestart.markRunning("running-operation");
      beforeRestart.markOutputTruncated("running-operation");
      expect(beforeRestart.receive("received-operation")).toBe("new");
      beforeRestart.close();

      const afterRestart = new OperationJournal(path);
      expect(afterRestart.recoverInterrupted()).toBe(2);
      expect(afterRestart.receive("running-operation")).toBe("completed");
      expect(afterRestart.receive("received-operation")).toBe("completed");
      expect(afterRestart.result("running-operation")).toMatchObject({
        status: "execution_unknown",
        error: "Client restarted before it could prove the Operation outcome",
        outputTruncated: true,
      });
      expect(afterRestart.resultsForReconciliation()).toEqual([
        expect.objectContaining({
          operationId: "running-operation",
          result: expect.objectContaining({ status: "execution_unknown" }),
        }),
        expect.objectContaining({
          operationId: "received-operation",
          result: expect.objectContaining({ status: "execution_unknown" }),
        }),
      ]);
      afterRestart.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconciles unconfirmed transport output conservatively after a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-journal-output-"));
    const path = join(directory, "operations.sqlite");
    try {
      const beforeRestart = new OperationJournal(path);
      const disconnectedBuffer = new ClientMessageBuffer(4, 1024);
      expect(beforeRestart.receive("completed-operation")).toBe("new");
      beforeRestart.markRunning("completed-operation");
      beforeRestart.markOutputUnconfirmed("completed-operation");
      expect(disconnectedBuffer.enqueue({
        type: "operation.event",
        operationId: "completed-operation",
        sequence: 0,
        stream: "stdout",
        dataBase64: Buffer.from("not-yet-flushed").toString("base64"),
      })).toEqual({ accepted: true });
      beforeRestart.complete("completed-operation", {
        status: "succeeded",
        exitCode: 0,
        outputTruncated: false,
      });
      expect(disconnectedBuffer.enqueue({
        type: "operation.completed",
        operationId: "completed-operation",
        status: "succeeded",
        exitCode: 0,
        outputTruncated: false,
        at: new Date(1).toISOString(),
      })).toEqual({ accepted: true });
      expect(beforeRestart.result("completed-operation")).toMatchObject({
        status: "succeeded",
        outputTruncated: false,
      });
      beforeRestart.close();

      const afterRestart = new OperationJournal(path);
      expect(afterRestart.recoverInterrupted()).toBe(0);
      expect(afterRestart.result("completed-operation")).toMatchObject({
        status: "succeeded",
        outputTruncated: true,
      });
      afterRestart.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains terminal results only until the Server acknowledges persistence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-journal-ack-"));
    const path = join(directory, "operations.sqlite");
    try {
      const journal = new OperationJournal(path);
      try {
        journal.receive("operation-a");
        journal.complete("operation-a", {
          status: "succeeded",
          exitCode: 0,
          outputTruncated: false,
        });
        expect(journal.resultsForReconciliation()).toHaveLength(1);

        journal.acknowledge("operation-a");

        expect(journal.resultsForReconciliation()).toEqual([]);
        expect(journal.result("operation-a")).toBeUndefined();
      } finally {
        journal.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("treats a duplicate start for an in-process Operation as idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-journal-duplicate-"));
    const path = join(directory, "operations.sqlite");
    try {
      const journal = new OperationJournal(path);
      try {
        expect(journal.receive("operation-id")).toBe("new");
        journal.markRunning("operation-id");

        expect(journal.receive("operation-id")).toBe("running");
        expect(journal.result("operation-id")).toBeUndefined();
      } finally {
        journal.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renders a restartable Linux user service without relying on PATH", () => {
    expect(linuxUserServicePath("/home/ada", {})).toBe(
      "/home/ada/.config/systemd/user/odyshell-client.service",
    );
    const unit = renderLinuxUserService({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/odyshell/dist/index.js",
      configPath: "/home/ada/.config/odyshell/client.json",
    });
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/opt/odyshell/dist/index.js" client start --config "/home/ada/.config/odyshell/client.json"',
    );
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("NoNewPrivileges=true");

    const sudoUnit = renderLinuxUserService({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/odyshell/dist/index.js",
      configPath: "/home/ada/.config/odyshell/client.json",
      allowPrivilegeEscalation: true,
    });
    expect(sudoUnit).toContain("NoNewPrivileges=false");
  });

  it("uses an isolated systemd service for every Client identity", () => {
    const first = linuxServiceNameForConfig(
      "/home/ada/.config/odyshell/clients/first/client.json",
    );
    const second = linuxServiceNameForConfig(
      "/home/ada/.config/odyshell/clients/second/client.json",
    );

    expect(first).toMatch(/^odyshell-client-[a-f0-9]{12}\.service$/);
    expect(second).toMatch(/^odyshell-client-[a-f0-9]{12}\.service$/);
    expect(first).not.toBe(second);
  });

  it("renders isolated shell-free services for macOS and Windows", () => {
    const configPath = "/Users/ada/Odyshell & tools/client.json";
    expect(macLaunchAgentLabelForConfig(configPath)).toMatch(
      /^com\.odyshell\.client\.[a-f0-9]{12}$/,
    );
    expect(macLaunchAgentPath(configPath, "/Users/ada")).toContain(
      "/Users/ada/Library/LaunchAgents/",
    );
    const plist = renderMacLaunchAgent({
      nodePath: "/opt/Node & tools/node",
      cliPath: "/opt/Odyshell/ods.js",
      configPath,
    });
    expect(plist).toContain("/opt/Node &amp; tools/node");
    expect(plist).toContain("<key>ProgramArguments</key>");

    const windowsConfig = "C:\\Users\\Ada & team\\client.json";
    expect(windowsTaskNameForConfig(windowsConfig)).toMatch(
      /^Odyshell Client [a-f0-9]{12}$/,
    );
    expect(() =>
      renderWindowsTaskLauncher({
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        cliPath: "C:\\Program Files\\Odyshell\\ods.js\r\nWrite-Output injected",
        configPath: windowsConfig,
      }),
    ).toThrow("control characters");
  });

  it("starts the Windows Client through a console-free per-Profile launcher", () => {
    const options = {
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      cliPath: "C:\\Program Files\\Odyshell\\ods.js",
      configPath: "C:\\Users\\Ada & team\\Odyshell\\clients\\work\\client.json",
    };

    expect(windowsTaskLauncherPath(options.configPath)).toBe(
      "C:\\Users\\Ada & team\\Odyshell\\clients\\work\\client-launcher-v1.exe",
    );
    expect(renderWindowsTaskLauncher(options)).toContain(
      "CreateNoWindow = true",
    );
    expect(renderWindowsTaskLauncher(options)).toContain(
      "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
    );
    expect(renderWindowsTaskLauncher(options)).not.toContain("WScript.Shell");
    expect(renderWindowsTaskLauncher(options)).not.toContain("ods_enroll_");

    const action = renderWindowsTaskAction(options, "C:\\Windows");
    expect(action.execute).toBe(
      "C:\\Users\\Ada & team\\Odyshell\\clients\\work\\client-launcher-v1.exe",
    );
    expect(action.arguments).toContain(
      '"C:\\Program Files\\nodejs\\node.exe"',
    );
    expect(action.arguments).toContain(
      '"C:\\Users\\Ada & team\\Odyshell\\clients\\work\\client.json"',
    );
    expect(action.arguments).not.toContain("ods_enroll_");

    expect(
      windowsTaskActionIsCurrent(action, options.configPath, {
        nodePath: options.nodePath,
        cliPath: options.cliPath,
      }),
    ).toBe(true);
    expect(
      windowsTaskActionIsCurrent(action, options.configPath, {
        nodePath: options.nodePath,
        cliPath: "C:\\Users\\Ada & team\\pnpm\\ods.js",
        canonicalizePath: () => options.cliPath,
      }),
    ).toBe(true);
    expect(
      windowsTaskActionIsCurrent(
        {
          execute: options.nodePath,
          arguments: `"${options.cliPath}" client start --config "${options.configPath}"`,
        },
        options.configPath,
        { nodePath: options.nodePath, cliPath: options.cliPath },
      ),
    ).toBe(false);
    expect(
      windowsTaskActionIsCurrent(
        { ...action, arguments: `"C:\\malware.exe" ${action.arguments}` },
        options.configPath,
        { nodePath: options.nodePath, cliPath: options.cliPath },
      ),
    ).toBe(false);
  });

  it("uses a deterministic isolated path for every named Client Profile", () => {
    expect(
      clientConfigPathForProfile(
        "personal",
        "linux",
        "/home/ada",
        {},
      ),
    ).toBe(
      "/home/ada/.config/odyshell/clients/personal/client.json",
    );
    expect(
      clientConfigPathForProfile(
        "company",
        "win32",
        "C:\\Users\\ada",
        { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" },
      ),
    ).toBe(
      "C:\\Users\\ada\\AppData\\Roaming\\Odyshell\\clients\\company\\client.json",
    );
    expect(() =>
      clientConfigPathForProfile("../company", "linux", "/home/ada", {}),
    ).toThrow("Client Profile name");
  });

  it("restarts an existing Linux service after replacing its configuration", async () => {
    const commands: string[][] = [];

    await activateLinuxUserService("odyshell-client-test.service", async (args) => {
      commands.push(args);
    });

    expect(commands).toEqual([
      ["daemon-reload"],
      ["enable", "odyshell-client-test.service"],
      ["restart", "odyshell-client-test.service"],
      ["is-active", "--quiet", "odyshell-client-test.service"],
    ]);
  });

  it("reloads an existing macOS LaunchAgent without shell interpolation", async () => {
    const commands: string[][] = [];

    await activateMacLaunchAgent(
      "/Users/ada/.config/odyshell/client.json",
      async (args) => {
        commands.push(args);
      },
      "gui/501",
    );

    expect(commands.map((args) => args[0])).toEqual([
      "bootout",
      "bootstrap",
      "kickstart",
      "print",
    ]);
  });
});
