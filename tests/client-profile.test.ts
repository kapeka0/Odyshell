import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  clientConfigPathForProfile,
  removeAllClientProfiles,
  removeClientProfile,
} from "../apps/client/src/index.js";

describe("Client Profile removal", () => {
  it("removes the local service before deleting the complete Profile directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "odyshell-profile-remove-"));
    const configPath = clientConfigPathForProfile("work", "linux", home, {});
    await mkdir(join(configPath, "..", "state"), { recursive: true });
    await writeFile(configPath, '{"machineId":"machine-1"}', "utf8");
    await writeFile(join(configPath, "..", "state", "runtime.json"), "{}", "utf8");
    const removedServices: string[] = [];

    const result = await removeClientProfile({
      profileName: "work",
      platform: "linux",
      home,
      environment: {},
      removeService: async (path) => {
        removedServices.push(path);
      },
    });

    expect(result).toEqual({ profileName: "work", configPath });
    expect(removedServices).toEqual([configPath]);
    await expect(access(join(configPath, ".."))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves the Profile identity when its service cannot be removed", async () => {
    const home = await mkdtemp(join(tmpdir(), "odyshell-profile-fail-"));
    const configPath = clientConfigPathForProfile("work", "linux", home, {});
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(configPath, '{"machineId":"machine-1"}', "utf8");

    await expect(
      removeClientProfile({
        profileName: "work",
        platform: "linux",
        home,
        environment: {},
        removeService: async () => {
          throw new Error("service manager unavailable");
        },
      }),
    ).rejects.toThrow("service manager unavailable");

    expect(await readFile(configPath, "utf8")).toContain("machine-1");
  });

  it("refuses to remove a Profile that does not exist", async () => {
    const home = await mkdtemp(join(tmpdir(), "odyshell-profile-missing-"));

    await expect(
      removeClientProfile({
        profileName: "missing",
        platform: "linux",
        home,
        environment: {},
        removeService: async () => {},
      }),
    ).rejects.toThrow('Client Profile "missing" does not exist');
  });

  it("removes every named and legacy Client identity during a reset", async () => {
    const home = await mkdtemp(join(tmpdir(), "odyshell-profile-reset-"));
    const profileConfig = clientConfigPathForProfile("work", "linux", home, {});
    const legacyConfig = join(home, ".config", "odyshell", "client.json");
    await mkdir(join(profileConfig, ".."), { recursive: true });
    await writeFile(profileConfig, '{"machineId":"profile"}', "utf8");
    await writeFile(legacyConfig, '{"machineId":"legacy"}', "utf8");
    const removedServices: string[] = [];

    const result = await removeAllClientProfiles({
      platform: "linux",
      home,
      environment: {},
      removeService: async (path) => {
        removedServices.push(path);
      },
    });

    expect(result.removed.map((entry) => entry.profileName).sort()).toEqual([
      "legacy",
      "work",
    ]);
    expect(removedServices).toHaveLength(2);
    expect(removedServices).toContain(profileConfig);
    expect(removedServices.map((path) => path.replaceAll("\\", "/"))).toContain(
      `${home.replaceAll("\\", "/")}/.config/odyshell/client.json`,
    );
    await expect(access(profileConfig)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(legacyConfig)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
