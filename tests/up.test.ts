import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertClientServerReachable,
  assertLinuxClientHost,
  resolveClientUpConfiguration,
} from "../apps/cli/src/up.js";

describe("ods up configuration safety", () => {
  it("enrolls a Task-native host Profile without legacy runtime controls", async () => {
    const source = await readFile(resolve(process.cwd(), "apps/cli/src/index.ts"), "utf8");
    const upCommand = source.slice(
      source.indexOf('.command("up")'),
      source.indexOf("async function machineIdFromClientConfig"),
    );
    expect(upCommand).toContain('.option("--agent-id <id>"');
    expect(upCommand).not.toContain("--mount-source");
    expect(upCommand).not.toContain("--runner");
    expect(upCommand).not.toContain("--allow");
    expect(upCommand).not.toContain("--cwd");
  });

  it("rejects non-Linux hosts before enrollment", () => {
    expect(() => assertLinuxClientHost("darwin")).toThrow("Linux hosts only");
    expect(() => assertLinuxClientHost("win32")).toThrow("Linux hosts only");
    expect(() => assertLinuxClientHost("linux")).not.toThrow();
  });

  it("fails when its Server is unreachable", async () => {
    await expect(
      assertClientServerReachable(
        "https://server-production.example",
        async () => Promise.reject(new Error("getaddrinfo EAI_AGAIN")),
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

  it("selects an isolated empty named Profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const profileConfigPath = join(root, "clients", "work", "client.json");
    await expect(resolveClientUpConfiguration({
      serverUrl: "https://server.example",
      profileName: "work",
      profileConfigPath,
    })).resolves.toEqual({ configPath: profileConfigPath, configExists: false });
  });

  it("reuses only the selected Profile identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const profileConfigPath = join(root, "clients", "work", "client.json");
    await writeClientConfig(profileConfigPath, "https://server.example", "work");
    await expect(resolveClientUpConfiguration({
      serverUrl: "https://server.example",
      profileName: "work",
      profileConfigPath,
    })).resolves.toEqual({ configPath: profileConfigPath, configExists: true });
  });

  it("refuses a configuration owned by another Server without leaking tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const explicitConfigPath = join(root, "explicit.json");
    await writeClientConfig(explicitConfigPath, "https://first.example");
    await expect(resolveClientUpConfiguration({
      serverUrl: "https://second.example",
      explicitConfigPath,
      profileName: "default",
      profileConfigPath: join(root, "clients", "default", "client.json"),
    })).rejects.toMatchObject({
      code: "client_config_server_mismatch",
      expected: true,
    });
  });

  it("rejects non-web Server URLs and credentials in URLs", async () => {
    await expect(resolveClientUpConfiguration({
      serverUrl: "file:///tmp/socket",
      profileName: "default",
      profileConfigPath: "/tmp/clients/default/client.json",
    })).rejects.toMatchObject({ code: "invalid_server_url" });
    await expect(resolveClientUpConfiguration({
      serverUrl: "https://user:secret@server.example",
      profileName: "default",
      profileConfigPath: "/tmp/clients/default/client.json",
    })).rejects.toMatchObject({ code: "invalid_server_url" });
  });

  it("fails closed for malformed or cross-Profile configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-up-"));
    const malformed = join(root, "malformed.json");
    await writeFile(malformed, '{"serverUrl":', "utf8");
    await expect(resolveClientUpConfiguration({
      serverUrl: "https://server.example",
      explicitConfigPath: malformed,
      profileName: "default",
      profileConfigPath: join(root, "clients", "default", "client.json"),
    })).rejects.toMatchObject({ code: "client_config_invalid" });

    const copied = join(root, "clients", "company", "client.json");
    await writeClientConfig(copied, "https://server.example", "personal");
    await expect(resolveClientUpConfiguration({
      serverUrl: "https://server.example",
      profileName: "company",
      profileConfigPath: copied,
    })).rejects.toMatchObject({ code: "client_config_profile_mismatch" });
  });

  it("rejects Profile names that could escape the Profile directory", async () => {
    await expect(resolveClientUpConfiguration({
      serverUrl: "https://server.example",
      profileName: "../other",
      profileConfigPath: "/tmp/clients/other/client.json",
    })).rejects.toMatchObject({ code: "invalid_client_profile" });
  });
});

async function writeClientConfig(path: string, serverUrl: string, profileName?: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({
    serverUrl,
    ...(profileName ? { profileName } : {}),
  }), "utf8");
}
