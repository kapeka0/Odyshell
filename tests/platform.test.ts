import { describe, expect, it } from "vitest";
import {
  clientConfigPathFor,
  containerUser,
  hostPlatform,
} from "../apps/client/src/platform.js";
import { parseDockerRuntime } from "../apps/client/src/docker-runner.js";
import {
  activateLinuxUserService,
  linuxUserServicePath,
  renderLinuxUserService,
} from "../apps/client/src/service.js";
import { cliConfigPathFor } from "../apps/cli/src/config.js";

describe("client platform support", () => {
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

  it("restarts an existing Linux service after replacing its configuration", async () => {
    const commands: string[][] = [];

    await activateLinuxUserService(async (args) => {
      commands.push(args);
    });

    expect(commands).toEqual([
      ["daemon-reload"],
      ["enable", "odyshell-client.service"],
      ["restart", "odyshell-client.service"],
      ["is-active", "--quiet", "odyshell-client.service"],
    ]);
  });
});
