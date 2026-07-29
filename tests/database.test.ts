import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../apps/server/src/database.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("server storage boundaries", () => {
  it("forbids ephemeral storage in production", () => {
    expect(() =>
      createDatabase({
        NODE_ENV: "production",
        ODYSHELL_STORAGE: "memory",
      }),
    ).toThrow(/forbidden in production/);
  });

  it("requires both Convex endpoint and service key", () => {
    expect(() => createDatabase({ NODE_ENV: "production" })).toThrow(/CONVEX_URL/);
    expect(() =>
      createDatabase({
        NODE_ENV: "production",
        CONVEX_URL: "https://example.convex.cloud",
      }),
    ).toThrow(/ODYSHELL_CONVEX_SERVICE_KEY/);
  });

  it("consumes enrollment tokens atomically", async () => {
    const database = createDatabase({
      NODE_ENV: "test",
      ODYSHELL_STORAGE: "memory",
    });
    const enrollmentToken = "single-use-token";
    const tokenHash = hash(enrollmentToken);
    const publicKey = generateKeyPairSync("ed25519").publicKey
      .export({
        type: "spki",
        format: "pem",
      })
      .toString();
    await database.createEnrollmentToken(tokenHash, Date.now() + 60_000);

    const first = await database.enrollMachine({
      tokenHash,
      machineId: randomUUID(),
      name: "first",
      publicKey,
    });
    const replay = await database.enrollMachine({
      tokenHash,
      machineId: randomUUID(),
      name: "replay",
      publicKey,
    });

    expect(first?.name).toBe("first");
    expect(replay).toBeNull();
  });

  it("rejects expired and revoked agent tokens", async () => {
    const database = createDatabase({
      NODE_ENV: "test",
      ODYSHELL_STORAGE: "memory",
    });
    await database.createAgentToken({
      id: "expired",
      name: "Expired agent",
      tokenHash: hash("expired-token"),
      machineIds: [],
      capabilities: ["process.exec"],
      expiresAt: Date.now() - 1,
    });
    await database.createAgentToken({
      id: "revoked",
      name: "Revoked agent",
      tokenHash: hash("revoked-token"),
      machineIds: [],
      capabilities: ["process.exec"],
      expiresAt: Date.now() + 60_000,
    });
    await database.revokeAgentToken("revoked");

    await expect(database.findAgentByTokenHash(hash("expired-token"))).resolves.toBeNull();
    await expect(database.findAgentByTokenHash(hash("revoked-token"))).resolves.toBeNull();
  });
});
