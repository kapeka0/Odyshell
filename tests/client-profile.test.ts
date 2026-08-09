import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  clientConfigPathForProfile,
  listClientProfiles,
  removeAllClientProfiles,
  removeClientProfile,
} from "../apps/client/src/index.js";

const stoppedService = {
  supported: true,
  installed: true,
  active: false,
  enabled: true,
};

describe("Client Profile listing", () => {
  it("lists valid Profiles in name order without exposing private keys", async () => {
    const home = await mkdtemp(join(tmpdir(), "odyshell-profile-list-"));
    const workConfig = clientConfigPathForProfile("work", "linux", home, {});
    const defaultConfig = clientConfigPathForProfile("default", "linux", home, {});
    await writeProfileConfig(workConfig, "work", "workstation");
    await writeProfileConfig(defaultConfig, "default", "desktop");

    const profiles = await listClientProfiles({
      platform: "linux",
      home,
      environment: {},
      getServiceStatus: async (configPath) => ({
        ...stoppedService,
        active: configPath === defaultConfig,
      }),
    });

    expect(profiles.map((profile) => profile.profileName)).toEqual([
      "default",
      "work",
    ]);
    expect(profiles[0]).toMatchObject({
      machineName: "desktop",
      serverUrl: "https://server.odyshell.test",
      valid: true,
      service: { active: true },
    });
    expect(JSON.stringify(profiles)).not.toContain("private-key");
  });

  it("shows malformed Profiles as invalid without returning their contents", async () => {
    const home = await mkdtemp(join(tmpdir(), "odyshell-profile-invalid-"));
    const configPath = clientConfigPathForProfile("broken", "linux", home, {});
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(configPath, '{"privateKeyPem":"do-not-leak"}', "utf8");

    const profiles = await listClientProfiles({
      platform: "linux",
      home,
      environment: {},
      getServiceStatus: async () => stoppedService,
    });

    expect(profiles).toEqual([
      {
        profileName: "broken",
        configPath,
        valid: false,
        service: stoppedService,
      },
    ]);
    expect(JSON.stringify(profiles)).not.toContain("do-not-leak");
  });

  it("ignores directories that cannot be valid Profile names", async () => {
    const home = await mkdtemp(join(tmpdir(), "odyshell-profile-name-"));
    const validConfig = clientConfigPathForProfile("valid", "linux", home, {});
    const clientsDirectory = join(validConfig, "..", "..");
    await writeProfileConfig(validConfig, "valid", "desktop");
    await mkdir(join(clientsDirectory, "INVALID"), { recursive: true });
    await writeFile(join(clientsDirectory, "INVALID", "client.json"), "{}", "utf8");

    const profiles = await listClientProfiles({
      platform: "linux",
      home,
      environment: {},
      getServiceStatus: async () => stoppedService,
    });

    expect(profiles.map((profile) => profile.profileName)).toEqual(["valid"]);
  });
});

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

async function writeProfileConfig(
  path: string,
  profileName: string,
  machineName: string,
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      serverUrl: "https://server.odyshell.test",
      profileName,
      machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
      machineName,
      privateKeyPem: "private-key",
      stateDirectory: join(path, "..", "state"),
      taskProfile: {
        id: profileName,
        localPolicy: {
          organizationId: "organization-one",
          maxTaskDurationSeconds: 3600,
          maxConcurrentTasks: 1,
          maxConcurrentCommands: 1,
          maxCommandTimeoutSeconds: 600,
          maxCommandOutputBytes: 1024 * 1024,
          allowRemoteApproval: true,
        },
      },
    }),
    "utf8",
  );
}
