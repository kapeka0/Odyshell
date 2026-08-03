import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadStoredConfig, saveStoredConfig } from "../apps/cli/src/config.js";
import { resetLocalOdyshell } from "../apps/cli/src/reset.js";

describe("ods reset", () => {
  it("removes every local Client Profile before deleting CLI credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-reset-"));
    const configPath = join(root, "config.json");
    await saveStoredConfig(
      {
        serverUrl: "https://server.example",
        workspaceId: "workspace-1",
        cliToken: "test-cli-token",
        mcpAgentId: "agent-1",
      },
      configPath,
    );

    const result = await resetLocalOdyshell({
      configPath,
      removeProfiles: async () => ({
        removed: [
          { profileName: "work", configPath: join(root, "work", "client.json") },
        ],
      }),
      revokeCli: async () => true,
    });

    expect(result).toMatchObject({ loggedOut: true, revoked: true });
    expect(result.removedProfiles).toEqual(["work"]);
    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps CLI credentials when a Client service cannot be removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "odyshell-reset-fail-"));
    const configPath = join(root, "config.json");
    await saveStoredConfig(
      { serverUrl: "https://server.example", cliToken: "test-cli-token" },
      configPath,
    );

    await expect(
      resetLocalOdyshell({
        configPath,
        removeProfiles: async () => {
          throw new Error("service manager unavailable");
        },
        revokeCli: async () => true,
      }),
    ).rejects.toThrow("service manager unavailable");

    expect(await loadStoredConfig(configPath)).toMatchObject({
      cliToken: "test-cli-token",
    });
  });
});
