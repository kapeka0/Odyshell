import { describe, expect, it } from "vitest";
import {
  connectorConfigPathFor,
  containerUser,
  hostPlatform,
} from "../apps/connector/src/platform.js";
import { parseDockerRuntime } from "../apps/connector/src/docker-runner.js";
import { clientConfigPathFor } from "../apps/cli/src/config.js";

describe("connector platform support", () => {
  it("maps Node platform names to public Odyshell platform names", () => {
    expect(hostPlatform("linux")).toBe("linux");
    expect(hostPlatform("darwin")).toBe("macos");
    expect(hostPlatform("win32")).toBe("windows");
    expect(() => hostPlatform("freebsd")).toThrow("Unsupported host platform");
  });

  it("uses the native application configuration directory", () => {
    expect(
      connectorConfigPathFor("win32", "C:\\Users\\ada", {
        APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
      }),
    ).toBe("C:\\Users\\ada\\AppData\\Roaming\\Odyshell\\connector.json");
    expect(connectorConfigPathFor("darwin", "/Users/ada", {})).toBe(
      "/Users/ada/Library/Application Support/Odyshell/connector.json",
    );
    expect(
      connectorConfigPathFor("linux", "/home/ada", {
        XDG_CONFIG_HOME: "/home/ada/.config-custom",
      }),
    ).toBe("/home/ada/.config-custom/odyshell/connector.json");
    expect(clientConfigPathFor("darwin", "/Users/ada", {})).toBe(
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
});
