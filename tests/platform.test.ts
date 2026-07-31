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
import { adjustedSessionDeadline } from "../apps/client/src/index.js";
import { clientCompatibility } from "../apps/server/src/compatibility.js";
import {
  activateMacLaunchAgent,
  activateLinuxUserService,
  linuxServiceNameForConfig,
  linuxUserServicePath,
  macLaunchAgentLabelForConfig,
  macLaunchAgentPath,
  renderMacLaunchAgent,
  renderLinuxUserService,
  renderWindowsTaskCommand,
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
        protocolVersion: 1,
        clientVersion: "0.9.0",
      }),
    ).toMatchObject({
      compatible: true,
      upgradeRequired: false,
      clientVersion: "0.9.0",
      protocolVersion: 1,
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
    expect(
      renderWindowsTaskCommand({
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        cliPath: "C:\\Program Files\\Odyshell\\ods.js",
        configPath: windowsConfig,
      }),
    ).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\Odyshell\\ods.js" "client" "start" "--config" "C:\\Users\\Ada & team\\client.json"',
    );
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
