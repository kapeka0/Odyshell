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
          containerId: "container",
          containerName: "container",
          profile: {
            runner: "docker",
            workspaceRoot: "/workspace",
            image: "alpine:3.22",
            network: "none",
            maxSessionTtlSeconds: 300,
            maxConcurrentSessions: 1,
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
});
