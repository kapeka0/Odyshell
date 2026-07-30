import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  resolveClientUpConfiguration,
} from "../apps/cli/src/up.js";

describe("ods up configuration safety", () => {
  it("reuses the existing identity when the machine is already enrolled with that server", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const legacyConfigPath = join(root, "client.json");
    await writeClientConfig(legacyConfigPath, "https://server.example");

    await expect(
      resolveClientUpConfiguration({
        serverUrl: "https://server.example/",
        legacyConfigPath,
        instanceConfigPath: join(root, "clients", "server", "client.json"),
      }),
    ).resolves.toEqual({
      configPath: legacyConfigPath,
      configExists: true,
    });
  });

  it("selects a separate identity for a different Odyshell server", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const legacyConfigPath = join(root, "client.json");
    const instanceConfigPath = join(
      root,
      "clients",
      "second-server",
      "client.json",
    );
    await writeClientConfig(legacyConfigPath, "https://first.example");

    await expect(
      resolveClientUpConfiguration({
        serverUrl: "https://second.example",
        legacyConfigPath,
        instanceConfigPath,
      }),
    ).resolves.toEqual({
      configPath: instanceConfigPath,
      configExists: false,
    });
  });

  it("reuses a previously enrolled identity for a second server", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const legacyConfigPath = join(root, "client.json");
    const instanceConfigPath = join(root, "clients", "server", "client.json");
    await writeClientConfig(legacyConfigPath, "https://first.example");
    await writeClientConfig(instanceConfigPath, "https://second.example");

    await expect(
      resolveClientUpConfiguration({
        serverUrl: "https://second.example",
        legacyConfigPath,
        instanceConfigPath,
      }),
    ).resolves.toEqual({
      configPath: instanceConfigPath,
      configExists: true,
    });
  });

  it("refuses an explicit configuration owned by another server without leaking tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const explicitConfigPath = join(root, "explicit.json");
    await writeClientConfig(explicitConfigPath, "https://first.example");

    await expect(
      resolveClientUpConfiguration({
        serverUrl: "https://second.example",
        explicitConfigPath,
        legacyConfigPath: join(root, "client.json"),
        instanceConfigPath: join(root, "clients", "server", "client.json"),
      }),
    ).rejects.toMatchObject({
      code: "client_config_server_mismatch",
      expected: true,
    });
  });

  it("rejects non-web server URLs", async () => {
    await expect(
      resolveClientUpConfiguration({
        serverUrl: "file:///tmp/socket",
        legacyConfigPath: "/tmp/client.json",
        instanceConfigPath: "/tmp/clients/server/client.json",
      }),
    ).rejects.toMatchObject({
      code: "invalid_server_url",
      expected: true,
    });
  });

  it("fails closed when an existing Client configuration is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const explicitConfigPath = join(root, "client.json");
    await writeFile(explicitConfigPath, '{"serverUrl":', "utf8");

    await expect(
      resolveClientUpConfiguration({
        serverUrl: "https://server.example",
        explicitConfigPath,
        legacyConfigPath: explicitConfigPath,
        instanceConfigPath: join(root, "clients", "server", "client.json"),
      }),
    ).rejects.toMatchObject({
      code: "client_config_invalid",
      expected: true,
    });
  });
});

async function writeClientConfig(path: string, serverUrl: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ serverUrl }), "utf8");
}
