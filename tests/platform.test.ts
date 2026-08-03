import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clientConfigPathFor,
  clientConfigPathForProfile,
  containerUser,
  hostPlatform,
} from "../apps/client/src/platform.js";
import { parseDockerRuntime } from "../apps/client/src/docker-runner.js";
import {
  adjustedSessionDeadline,
  inspectClientRuntime,
  terminateLocalAuthority,
} from "../apps/client/src/index.js";
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

  it("maps Node platform names to public Odyshell platform names", () => {
    expect(hostPlatform("linux")).toBe("linux");
    expect(hostPlatform("darwin")).toBe("macos");
    expect(hostPlatform("win32")).toBe("windows");
    expect(() => hostPlatform("freebsd")).toThrow("Unsupported host platform");
  });

  it("reports profile capabilities without exposing local paths", async () => {
    const runtime = await inspectClientRuntime(["host"], {
      workspace: {
        runner: "host",
        workspaceRoot: "C:\\Users\\ada\\private",
        maxSessionTtlSeconds: 900,
        maxConcurrentSessions: 2,
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
    expect(JSON.stringify(runtime)).not.toContain("private");
    expect(JSON.stringify(runtime)).not.toContain("workspaceRoot");
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
    expect(clientCompatibility(undefined)).toMatchObject({
      compatible: true,
      upgradeRequired: false,
      protocolVersion: null,
    });
    expect(
      clientCompatibility({
        protocolVersion: 2,
        clientVersion: "0.9.0",
      }),
    ).toMatchObject({
      compatible: true,
      upgradeRequired: false,
      clientVersion: "0.9.0",
      protocolVersion: 2,
    });
    expect(
      clientCompatibility({
        protocolVersion: 999,
        clientVersion: "0.1.0",
      }),
    ).toMatchObject({
      compatible: false,
      upgradeRequired: true,
      protocolVersion: 999,
    });
    const gateway = readFileSync(
      resolve(process.cwd(), "apps/server/src/gateway.ts"),
      "utf8",
    );
    expect(gateway.indexOf('throw new Error("Invalid client signature")')).toBeLessThan(
      gateway.indexOf("message.protocolVersion !== PROTOCOL_VERSION"),
    );
    expect(gateway).toContain("setMachineIncompatible");
    expect(gateway).toContain("queueMachineLifecycle(");
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

  it("does not activate a socket that closes while authentication is queued", async () => {
    const queue = new MachineLifecycleQueue();
    const socket = { readyState: 1 };
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
      gateway.indexOf("await this.queueMachineLifecycle(message.machineId"),
    );
    expect(gateway).toContain("if (!socketReadyForAuthentication(socket)) return");
  });

  it("resumes an identical local Session after transport reconnect", () => {
    const client = readFileSync(
      resolve(process.cwd(), "apps/client/src/index.ts"),
      "utf8",
    );

    expect(client).toContain("const existing = this.sessions.get(message.sessionId)");
    expect(client).toContain("sessionScopeSubsetDecision(requested, current)");
    expect(client).toContain("sessionScopeSubsetDecision(current, requested)");
    expect(client).toContain("Session retry scope does not match active local authority");
    expect(client).toContain("await this.dropLocalAuthority()");
    expect(client).toContain("void this.dropLocalAuthority()");
    expect(client).toContain("this.operations.clear()");
    expect(client).toContain("this.sessions.clear()");
    expect(client).toContain("Local authority cleanup could not be verified; Client stopped");
  });

  it("terminates Operations and local Session state before reconnect", async () => {
    const events: string[] = [];
    await terminateLocalAuthority(
      [async () => { events.push("operation:cancelled"); }],
      [async () => { events.push("session:closed"); }],
    );

    expect(events).toEqual(["operation:cancelled", "session:closed"]);
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
