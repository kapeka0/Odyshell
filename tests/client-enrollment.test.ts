import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enrollClient } from "../apps/client/src/index.js";

describe("Client enrollment", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("persists a conservative Task Local Policy without the one-time token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-enroll-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "client.json");
    await writeFile(configPath, "old identity", "utf8");
    const previousMachineId = crypto.randomUUID();
    const nextMachineId = crypto.randomUUID();
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        machineId: nextMachineId,
        workspaceId: "workspace-one",
        organizationId: "organization-one",
      }, { status: 201 });
    });

    const result = await enrollClient({
      serverUrl: "https://server.example",
      token: "ods_enroll_secret",
      machineName: "desktop",
      agentId: "agent-primary",
      configPath,
      previousMachineId,
      replaceConfig: true,
    });

    expect(result.machineId).toBe(nextMachineId);
    expect(requests).toEqual([
      expect.objectContaining({ previousMachineId, name: "desktop" }),
    ]);
    const source = await readFile(configPath, "utf8");
    expect(source).not.toContain("ods_enroll_secret");
    const saved = JSON.parse(source) as {
      taskProfile: unknown;
    };
    expect(saved.taskProfile).toEqual({
      id: "default",
      localPolicy: {
        organizationId: "organization-one",
        agentIds: ["agent-primary"],
        maxTaskDurationSeconds: 3_600,
        maxConcurrentTasks: 1,
        maxConcurrentCommands: 1,
        maxCommandTimeoutSeconds: 600,
        maxCommandOutputBytes: 1024 * 1024,
        allowRemoteApproval: true,
      },
    });
    expect(saved).not.toHaveProperty("profiles");
    expect(saved).not.toHaveProperty("allowPrivilegeEscalation");
    expect(saved).not.toHaveProperty("workspaceId");
  });

  it("rejects an empty Agent identity before consuming enrollment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-enroll-agent-denied-"));
    temporaryDirectories.push(directory);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(enrollClient({
      serverUrl: "https://server.example",
      token: "ods_enroll_secret",
      machineName: "desktop",
      agentId: "   ",
      configPath: join(directory, "client.json"),
    })).rejects.toThrow("One valid Agent ID must be explicitly allowed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("registers a Machine without an Agent using a default-deny Local Policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-enroll-no-agent-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "client.json");
    vi.stubGlobal("fetch", async () => Response.json({
      machineId: crypto.randomUUID(),
      organizationId: "organization-one",
    }, { status: 201 }));

    await enrollClient({
      serverUrl: "https://server.example",
      token: "ods_enroll_secret",
      machineName: "unassigned-host",
      configPath,
    });

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      taskProfile: { localPolicy: { agentIds: string[] } };
    };
    expect(saved.taskProfile.localPolicy.agentIds).toEqual([]);
  });

  it("fails closed when enrollment has no sovereign Organization identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-enroll-org-denied-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "client.json");
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: "organization_identity_required" }, { status: 409 }));

    await expect(enrollClient({
      serverUrl: "https://server.example",
      token: "ods_enroll_secret",
      machineName: "desktop",
      agentId: "agent-primary",
      configPath,
    })).rejects.toThrow("organization_identity_required");
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
