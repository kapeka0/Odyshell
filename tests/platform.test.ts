import { describe, expect, it } from "vitest";
import {
  clientConfigPathForServer,
  clientConfigPathFor,
  containerUser,
  hostPlatform,
} from "../apps/client/src/platform.js";
import { parseDockerRuntime } from "../apps/client/src/docker-runner.js";
import {
  activateLinuxUserService,
  linuxServiceNameForConfig,
  linuxUserServicePath,
  renderLinuxUserService,
} from "../apps/client/src/service.js";
import {
  DEFAULT_CLOUD_SERVER_URL,
  cliConfigPathFor,
  serverUrlFor,
} from "../apps/cli/src/config.js";

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

  it("isolates Client configuration by normalized server identity", () => {
    const first = clientConfigPathForServer(
      "https://server.example/",
      "linux",
      "/home/ada",
      {},
    );
    const same = clientConfigPathForServer(
      "https://server.example",
      "linux",
      "/home/ada",
      {},
    );
    const second = clientConfigPathForServer(
      "https://other.example",
      "linux",
      "/home/ada",
      {},
    );

    expect(first).toBe(same);
    expect(first).toMatch(
      /^\/home\/ada\/\.config\/odyshell\/clients\/server-example-[a-f0-9]{12}\/client\.json$/,
    );
    expect(second).not.toBe(first);
    expect(
      clientConfigPathForServer(
        "https://server.example",
        "win32",
        "C:\\Users\\ada",
        { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" },
      ),
    ).toMatch(
      /^C:\\Users\\ada\\AppData\\Roaming\\Odyshell\\clients\\server-example-[a-f0-9]{12}\\client\.json$/,
    );
    expect(() =>
      clientConfigPathForServer(
        "https://user:secret@server.example",
        "linux",
        "/home/ada",
        {},
      ),
    ).toThrow("must not contain credentials");
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
});
