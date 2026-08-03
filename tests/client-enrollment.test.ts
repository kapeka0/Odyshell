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
      temporaryDirectories.splice(0).map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });

  it("replaces a revoked remote identity without persisting the enrollment token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-enroll-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "client.json");
    await writeFile(configPath, "old identity", "utf8");
    const previousMachineId = crypto.randomUUID();
    const nextMachineId = crypto.randomUUID();
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json(
        { machineId: nextMachineId, workspaceId: "workspace-one" },
        { status: 201 },
      );
    });

    const result = await enrollClient({
      serverUrl: "https://server.example",
      token: "ods_enroll_secret",
      machineName: "desktop",
      workspaceRoot: directory,
      configPath,
      allowedCapabilities: ["fs.read"],
      previousMachineId,
      replaceConfig: true,
    });

    expect(result.machineId).toBe(nextMachineId);
    expect(requests).toEqual([
      expect.objectContaining({ previousMachineId, name: "desktop" }),
    ]);
    const source = await readFile(configPath, "utf8");
    expect(source).toContain(nextMachineId);
    expect(source).not.toContain(previousMachineId);
    expect(source).not.toContain("ods_enroll_secret");
  });
});
