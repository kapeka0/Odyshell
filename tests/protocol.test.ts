import { describe, expect, it } from "vitest";
import {
  agentTokenRequestSchema,
  clientConfigSchema,
  operationRequestSchema,
  sessionRequestSchema,
} from "../packages/protocol/src/index.js";

describe("protocol validation", () => {
  it("rejects absolute and parent-traversing filesystem paths at the workspace boundary", () => {
    expect(
      operationRequestSchema.safeParse({ action: { kind: "fs.read", path: "/etc/passwd" } }).success,
    ).toBe(false);
    expect(
      operationRequestSchema.safeParse({ action: { kind: "fs.read", path: "C:\\Windows" } }).success,
    ).toBe(false);
    expect(
      operationRequestSchema.safeParse({ action: { kind: "fs.read", path: "../../etc/passwd" } })
        .success,
    ).toBe(false);
  });

  it("accepts a bounded structured process request", () => {
    expect(
      operationRequestSchema.safeParse({
        action: { kind: "process.exec", program: "printf", args: ["hello"], cwd: ".", env: {} },
      }).success,
    ).toBe(true);
  });

  it("accepts structured filesystem search and Docker log operations", () => {
    expect(
      operationRequestSchema.safeParse({
        action: { kind: "fs.search", path: ".", query: "package", maxResults: 50 },
      }).success,
    ).toBe(true);
    expect(
      operationRequestSchema.safeParse({
        action: { kind: "docker.logs", container: "api", tail: 100, timestamps: true },
      }).success,
    ).toBe(true);
    expect(
      operationRequestSchema.safeParse({
        action: { kind: "docker.logs", container: "api; rm -rf /" },
      }).success,
    ).toBe(false);
  });

  it("rejects excessive session leases", () => {
    expect(
      sessionRequestSchema.safeParse({
        machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
        ttlSeconds: 7200,
        capabilities: ["process.exec"],
      }).success,
    ).toBe(false);
  });

  it("requires agent tokens to be explicitly scoped", () => {
    expect(
      agentTokenRequestSchema.safeParse({
        name: "reader",
        machineIds: [],
        capabilities: ["fs.read"],
        expiresInSeconds: 600,
      }).success,
    ).toBe(false);
    expect(
      agentTokenRequestSchema.safeParse({
        name: "reader",
        machineIds: ["2dc24de7-ec0e-45b3-88c1-acbb900e51f8"],
        capabilities: [],
        expiresInSeconds: 600,
      }).success,
    ).toBe(false);
  });

  it("fails closed when a client profile enables network access", () => {
    const config = {
      serverUrl: "http://127.0.0.1:4100",
      machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
      machineName: "test-machine",
      privateKeyPem: "private-key",
      stateDirectory: "/tmp/odyshell",
      profiles: {
        workspace: {
          runner: "docker",
          workspaceRoot: "/tmp/workspace",
          image: "alpine:3.22",
          network: "bridge",
          maxSessionTtlSeconds: 1800,
          maxConcurrentSessions: 2,
          maxOutputBytes: 1024 * 1024,
          capabilities: ["process.exec"],
        },
      },
    };

    expect(clientConfigSchema.safeParse(config).success).toBe(false);
    expect(
      clientConfigSchema.safeParse({
        ...config,
        profiles: {
          workspace: { ...config.profiles.workspace, network: "none" },
        },
      }).success,
    ).toBe(true);
  });

  it("accepts direct host execution as an explicit local profile", () => {
    expect(
      clientConfigSchema.safeParse({
        serverUrl: "https://api.odyshell.test",
        machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
        machineName: "linux-server",
        privateKeyPem: "private-key",
        stateDirectory: "/home/odyshell/.local/state/odyshell",
        profiles: {
          workspace: {
            runner: "host",
            workspaceRoot: "/srv/app",
            maxSessionTtlSeconds: 1800,
            maxConcurrentSessions: 2,
            maxOutputBytes: 1024 * 1024,
            capabilities: ["process.exec", "fs.read", "fs.write"],
          },
        },
      }).success,
    ).toBe(true);
  });
});
