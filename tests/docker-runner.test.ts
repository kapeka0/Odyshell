import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DockerRunner,
  isContainerAlreadyRemoved,
} from "../apps/client/src/docker-runner.js";

describe("DockerRunner cleanup", () => {
  it("treats an absent container as an idempotent close", () => {
    expect(
      isContainerAlreadyRemoved(
        new Error("Error response from daemon: No such container: odyshell-session"),
      ),
    ).toBe(true);
  });

  it("treats concurrent Docker removal as an idempotent close", () => {
    expect(
      isContainerAlreadyRemoved(
        new Error(
          "Error response from daemon: removal of container odyshell-session is already in progress",
        ),
      ),
    ).toBe(true);
  });

  it("does not hide unrelated Docker failures", () => {
    expect(
      isContainerAlreadyRemoved(
        new Error("permission denied while trying to connect to the Docker daemon"),
      ),
    ).toBe(false);
  });

  it("does not expose absolute host paths through a Docker profile", async () => {
    const runner = new DockerRunner(crypto.randomUUID());
    const expiryTimer = setTimeout(() => undefined, 60_000);
    try {
      await expect(runner.execute(
        crypto.randomUUID(),
        {
          id: crypto.randomUUID(),
          runner: "docker",
          runtimeId: "container",
          containerName: "container",
          profile: {
            runner: "docker",
            mountSource: "/workspace",
            image: "alpine:3.22",
            network: "none",
            maxSessionTtlSeconds: 300,
            maxConcurrentSessions: 1,
            maxConcurrentOperations: 4,
            maxOperationTimeoutSeconds: 3_600,
            maxOutputBytes: 1_024,
            capabilities: ["fs.read"],
          },
          capabilities: new Set(["fs.read"]),
          restrictions: {
            filesystem: {
              paths: [{ path: "/etc/passwd", includeDescendants: false }],
            },
          },
          expiresAt: new Date(Date.now() + 60_000),
          expiryTimer,
        },
        { kind: "fs.read", path: "/etc/passwd" },
        { stdout() {}, stderr() {}, result() {} },
      )).rejects.toThrow("require a host execution profile");
    } finally {
      clearTimeout(expiryTimer);
    }
  });

  it("rejects host filesystem work after a Docker Session closes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "odyshell-docker-closed-"));
    const runner = new DockerRunner(crypto.randomUUID());
    const expiryTimer = setTimeout(() => undefined, 60_000);
    const session = {
      id: crypto.randomUUID(),
      runner: "docker" as const,
      runtimeId: "container",
      profile: {
        runner: "docker" as const,
        mountSource: workspace,
        image: "alpine:3.22",
        network: "none" as const,
        maxSessionTtlSeconds: 300,
        maxConcurrentSessions: 1,
        maxConcurrentOperations: 4,
        maxOperationTimeoutSeconds: 3_600,
        maxOutputBytes: 1_024,
        capabilities: ["fs.read" as const],
      },
      capabilities: new Set(["fs.read" as const]),
      restrictions: undefined,
      expiresAt: new Date(Date.now() + 60_000),
      expiryTimer,
    };
    try {
      await writeFile(join(workspace, "secret.txt"), "must not be read");
      await runner.closeSession(session);

      await expect(
        runner.execute(
          crypto.randomUUID(),
          session,
          { kind: "fs.read", path: "secret.txt" },
          { stdout() {}, stderr() {}, result() {} },
        ),
      ).rejects.toThrow("Session is closed on this client");
    } finally {
      clearTimeout(expiryTimer);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
