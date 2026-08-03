import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertClientServerReachable,
  resolveClientUpConfiguration,
} from "../apps/cli/src/up.js";

describe("ods up configuration safety", () => {
  it("fails before claiming the Client is running when its Server is unreachable", async () => {
    const networkError = new Error(
      "getaddrinfo EAI_AGAIN server-production.example",
    );

    await expect(
      assertClientServerReachable(
        "https://server-production.example",
        async () => Promise.reject(networkError),
      ),
    ).rejects.toMatchObject({
      code: "client_server_unreachable",
      expected: true,
    });
  });

  it("accepts only a healthy Odyshell Server", async () => {
    await expect(
      assertClientServerReachable(
        "https://server.example",
        async () => new Response('{"status":"ok"}', { status: 200 }),
      ),
    ).resolves.toBeUndefined();

    await expect(
      assertClientServerReachable(
        "https://server.example",
        async () => new Response("unavailable", { status: 503 }),
      ),
    ).rejects.toMatchObject({ code: "client_server_unavailable" });
  });

  it("imports the legacy identity into the explicit default profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const legacyConfigPath = join(root, "client.json");
    const profileConfigPath = join(
      root,
      "clients",
      "default",
      "client.json",
    );
    await writeClientConfig(legacyConfigPath, "https://server.example");

    await expect(
      resolveClientUpConfiguration({
        serverUrl: "https://server.example/",
        profileName: "default",
        legacyConfigPath,
        profileConfigPath,
      }),
    ).resolves.toEqual({
      configPath: profileConfigPath,
      configExists: true,
      migratedFrom: legacyConfigPath,
    });
  });

  it("selects an isolated empty profile without falling back to the default identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const legacyConfigPath = join(root, "client.json");
    const profileConfigPath = join(root, "clients", "work", "client.json");
    await writeClientConfig(legacyConfigPath, "https://first.example");

    await expect(
      resolveClientUpConfiguration({
        serverUrl: "https://second.example",
        profileName: "work",
        legacyConfigPath,
        profileConfigPath,
      }),
    ).resolves.toEqual({
      configPath: profileConfigPath,
      configExists: false,
    });
  });

  it("reuses only the selected profile identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const legacyConfigPath = join(root, "client.json");
    const profileConfigPath = join(root, "clients", "work", "client.json");
    await writeClientConfig(legacyConfigPath, "https://first.example");
    await writeClientConfig(
      profileConfigPath,
      "https://second.example",
      "work",
    );

    await expect(
      resolveClientUpConfiguration({
        serverUrl: "https://second.example",
        profileName: "work",
        legacyConfigPath,
        profileConfigPath,
      }),
    ).resolves.toEqual({
      configPath: profileConfigPath,
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
        profileName: "default",
        legacyConfigPath: join(root, "client.json"),
        profileConfigPath: join(root, "clients", "default", "client.json"),
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
        profileName: "default",
        legacyConfigPath: "/tmp/client.json",
        profileConfigPath: "/tmp/clients/default/client.json",
      }),
    ).rejects.toMatchObject({
      code: "invalid_server_url",
      expected: true,
    });
    await expect(
      resolveClientUpConfiguration({
        serverUrl: "https://user:secret@server.example",
        profileName: "default",
        legacyConfigPath: "/tmp/client.json",
        profileConfigPath: "/tmp/clients/default/client.json",
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
        profileName: "default",
        legacyConfigPath: explicitConfigPath,
        profileConfigPath: join(root, "clients", "default", "client.json"),
      }),
    ).rejects.toMatchObject({
      code: "client_config_invalid",
      expected: true,
    });
  });

  it("fails closed when both legacy and default profile identities exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const legacyConfigPath = join(root, "client.json");
    const profileConfigPath = join(
      root,
      "clients",
      "default",
      "client.json",
    );
    await writeClientConfig(legacyConfigPath, "https://server.example");
    await writeClientConfig(profileConfigPath, "https://server.example");

    await expect(
      resolveClientUpConfiguration({
        serverUrl: "https://server.example",
        profileName: "default",
        legacyConfigPath,
        profileConfigPath,
      }),
    ).rejects.toMatchObject({
      code: "client_profile_migration_conflict",
      expected: true,
    });
  });

  it("rejects profile names that could escape the profile directory", async () => {
    await expect(
      resolveClientUpConfiguration({
        serverUrl: "https://server.example",
        profileName: "../other",
        legacyConfigPath: "/tmp/client.json",
        profileConfigPath: "/tmp/clients/other/client.json",
      }),
    ).rejects.toMatchObject({
      code: "invalid_client_profile",
      expected: true,
    });
  });

  it("rejects a configuration copied from another named Profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const profileConfigPath = join(root, "clients", "company", "client.json");
    await writeClientConfig(
      profileConfigPath,
      "https://server.example",
      "personal",
    );

    await expect(
      resolveClientUpConfiguration({
        serverUrl: "https://server.example",
        profileName: "company",
        legacyConfigPath: join(root, "client.json"),
        profileConfigPath,
      }),
    ).rejects.toMatchObject({
      code: "client_config_profile_mismatch",
      expected: true,
    });
  });
});

async function writeClientConfig(
  path: string,
  serverUrl: string,
  profileName?: string,
) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      serverUrl,
      ...(profileName ? { profileName } : {}),
    }),
    "utf8",
  );
}
