import { describe, expect, it } from "vitest";
import {
  CloudLiveTokenReplayGuard,
  createCloudLiveToken,
  createCloudAgentAccessSchema,
  deleteCloudAgentAccessSchema,
  cloudLiveOriginDecision,
  cloudIdentitySchema,
  cloudManualSessionSchema,
  cloudUserSettingsSchema,
  cloudWorkspaceSettingsSchema,
  cloudConnectionView,
  cloudWebRequestDecision,
  cloudWebKey,
  cloudWebUrl,
  createDeviceUserCode,
  deviceApprovalDecision,
  deviceExchangeDecision,
  entitlementsFor,
  FixedWindowRateLimiter,
  normalizeDeviceUserCode,
  privacySafeControlMetadata,
  revokeCloudAgentAccessSchema,
  revokeCloudMachineSchema,
  updateCloudMachineSchema,
  ScopedConcurrencyLimiter,
  ScopedRateLimiter,
  verifyCloudLiveToken,
} from "../apps/server/src/cloud.js";
import { cloudRouteIdentityDecision } from "../apps/web/src/lib/cloud-route-policy.js";

describe("cloud identity and device authorization boundaries", () => {
  it("validates identity-bound user and workspace settings", () => {
    const identity = {
      userId: "user_123",
      userName: "Karim Ahmed",
      role: "owner" as const,
      organization: { externalId: "org_123", slug: "acme", name: "Acme" },
    };
    expect(cloudUserSettingsSchema.safeParse({ ...identity, timeZone: "Europe/Madrid" }).success).toBe(true);
    expect(cloudUserSettingsSchema.safeParse({ ...identity, timeZone: "Mars/Olympus" }).success).toBe(false);
    expect(cloudWorkspaceSettingsSchema.safeParse({
      ...identity,
      section: "details",
      name: "Production",
      avatarSeed: "seed",
    }).success).toBe(true);
    expect(cloudWorkspaceSettingsSchema.safeParse({
      ...identity,
      section: "logging",
      loggingLevel: "everything",
      workspaceId: "attacker-workspace",
    }).success).toBe(false);
    expect(cloudWorkspaceSettingsSchema.safeParse({
      ...identity,
      section: "logging",
      loggingLevel: "operational",
      name: "must-not-be-accepted",
    }).success).toBe(false);
  });

  it("requires a signed-in organization member for every web mutation", () => {
    expect(cloudRouteIdentityDecision(null, null)).toBe("not_authenticated");
    expect(cloudRouteIdentityDecision("user_123", null)).toBe(
      "organization_required",
    );
    expect(cloudRouteIdentityDecision("user_123", "org_123")).toBe(
      "authorized",
    );
  });

  it("creates unambiguous, normalized eight-character user codes", () => {
    const code = createDeviceUserCode(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(normalizeDeviceUserCode(` ${code.toLowerCase()} `)).toHaveLength(8);
    expect(normalizeDeviceUserCode("ab-cd ef_gh")).toBe("ABCDEFGH");
  });

  it("rejects malformed or overlong cloud identities", () => {
    expect(
      cloudIdentitySchema.safeParse({
        userId: "user",
        role: "member",
        organization: { externalId: "org", slug: "acme", name: "Acme" },
      }).success,
    ).toBe(false);
    expect(
      cloudIdentitySchema.safeParse({
        userId: "user",
        organization: { externalId: "org", slug: "acme", name: "Acme" },
      }).success,
    ).toBe(false);
    expect(
      cloudIdentitySchema.safeParse({
        userId: "user",
        organization: { externalId: "org", slug: "../escape", name: "Acme" },
      }).success,
    ).toBe(false);
    expect(
      cloudIdentitySchema.safeParse({
        userId: "",
        organization: { externalId: "org", slug: "acme", name: "Acme" },
      }).success,
    ).toBe(false);
    expect(
      cloudIdentitySchema.safeParse({
        userId: "user",
        userName: "x".repeat(129),
        organization: { externalId: "org", slug: "acme", name: "Acme" },
      }).success,
    ).toBe(false);
  });

  it("binds cloud mutations to the authenticated identity instead of client workspace input", () => {
    const identity = {
      userId: "user_123",
      role: "admin" as const,
      organization: {
        externalId: "org_123",
        slug: "acme",
        name: "Acme",
      },
    };
    const access = {
      ...identity,
      name: "release-agent",
      machineIds: ["2dc24de7-ec0e-45b3-88c1-acbb900e51f8"],
      capabilities: ["process.exec"],
      expiresInSeconds: 60 * 60,
    };

    expect(createCloudAgentAccessSchema.safeParse(access).success).toBe(true);
    expect(
      createCloudAgentAccessSchema.safeParse({
        ...access,
        workspaceId: "attacker-workspace",
      }).success,
    ).toBe(false);
    expect(
      revokeCloudAgentAccessSchema.safeParse({
        ...identity,
        tokenId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
        workspaceId: "attacker-workspace",
      }).success,
    ).toBe(false);
    expect(
      deleteCloudAgentAccessSchema.safeParse({
        ...identity,
        tokenId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
        workspaceId: "attacker-workspace",
      }).success,
    ).toBe(false);
    expect(
      revokeCloudMachineSchema.safeParse({
        ...identity,
        machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
        workspaceId: "attacker-workspace",
      }).success,
    ).toBe(false);
    const machineUpdate = {
      ...identity,
      machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
      name: "Build server",
      description: "Linux builder",
      capabilities: ["fs.read", "process.exec"],
    };
    expect(updateCloudMachineSchema.safeParse(machineUpdate).success).toBe(true);
    expect(updateCloudMachineSchema.safeParse({
      ...machineUpdate,
      workspaceId: "attacker-workspace",
    }).success).toBe(false);
    expect(updateCloudMachineSchema.safeParse({
      ...machineUpdate,
      capabilities: ["fs.read", "fs.read"],
    }).success).toBe(false);
  });

  it("allows only intent-level capabilities through manual Session creation", () => {
    const identity = {
      userId: "user_123",
      role: "supervisor" as const,
      organization: {
        externalId: "org_123",
        slug: "acme",
        name: "Acme",
      },
    };
    const machineId = "2dc24de7-ec0e-45b3-88c1-acbb900e51f8";
    const agentId = "21a970a0-d42a-44ab-bf3f-f0a5f2ada248";
    const request = {
      ...identity,
      title: "Maintain machine",
      agentId,
      durationSeconds: 3_600,
      scopes: [{
        machineId,
        profile: "default",
        capabilities: [
          "host.shell",
          "fs.stat",
          "fs.list",
          "fs.search",
          "fs.read",
          "fs.write",
          "fs.mkdir",
          "fs.remove",
        ],
        restrictions: {},
      }],
    };

    expect(cloudManualSessionSchema.safeParse(request).success).toBe(true);
    expect(
      cloudManualSessionSchema.safeParse({
        ...request,
        durationSeconds: 5 * 60,
      }).success,
    ).toBe(true);
    expect(
      cloudManualSessionSchema.safeParse({
        ...request,
        durationSeconds: 5 * 60 - 1,
      }).success,
    ).toBe(false);
    expect(
      cloudManualSessionSchema.safeParse({
        ...request,
        scopes: [{
          machineId,
          profile: "default",
          capabilities: ["process.exec"],
          restrictions: {
            process: {
              programs: [{
                program: "git",
                args: ["status"],
                cwd: { path: ".", includeDescendants: false },
              }],
            },
          },
        }],
      }).success,
    ).toBe(false);
    expect(
      cloudManualSessionSchema.safeParse({
        ...request,
        scopes: [{
          machineId,
          profile: "default",
          capabilities: ["docker.logs"],
          restrictions: { docker: { containers: ["api"] } },
        }],
      }).success,
    ).toBe(false);
    expect(
      cloudManualSessionSchema.safeParse({
        ...request,
        scopes: [
          request.scopes[0],
          { ...request.scopes[0], machineId: agentId },
        ],
      }).success,
    ).toBe(false);
  });

  it("never exposes operation content through cloud control events", () => {
    const machineId = "2dc24de7-ec0e-45b3-88c1-acbb900e51f8";
    const parentAgentId = "21a970a0-d42a-44ab-bf3f-f0a5f2ada248";
    const managedAgentId = "6be716f5-91bd-4329-8bdd-cb004acfc7a0";
    expect(
      privacySafeControlMetadata({
        kind: "process.exec",
        reason: "machine_scope",
        machineId,
        parentAgentId,
        managedAgentId,
        command: "cat /etc/shadow",
        path: "/etc/shadow",
        stdout: "secret",
        stderr: "secret",
      }),
    ).toEqual({
      kind: "process.exec",
      reason: "machine_scope",
      machineId,
      parentAgentId,
      managedAgentId,
    });
  });

  it("exposes only topology-safe connection metadata to the dashboard", () => {
    const internalConnection = {
      id: "session-1",
      machineId: "machine-1",
      principalId: "agent-1",
      status: "ready",
      command: "cat /etc/shadow",
      stdout: "secret",
    };
    expect(
      cloudConnectionView(internalConnection, "Release agent"),
    ).toEqual({
      id: "session-1",
      machineId: "machine-1",
      agentId: "agent-1",
      agentName: "Release agent",
      status: "ready",
    });
  });

  it("drops attacker-controlled control metadata even when it uses safe field names", () => {
    expect(
      privacySafeControlMetadata({
        kind: "cat /etc/shadow",
        reason: "secret copied from stdout",
        machineId: "../../private-machine",
        parentAgentId: "not-a-uuid",
        managedAgentId: "../../../other-agent",
      }),
    ).toEqual({});
    expect(
      privacySafeControlMetadata({
        kind: "fs.read",
        reason: "client_rejected",
        machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
      }),
    ).toEqual({
      kind: "fs.read",
      reason: "client_rejected",
      machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
    });
  });

  it("fails closed on weak production web credentials and insecure origins", () => {
    expect(() =>
      cloudWebKey({ NODE_ENV: "production", ODYSHELL_WEB_KEY: "short" }),
    ).toThrow(/32 characters/);
    expect(() =>
      cloudWebUrl(
        {
          NODE_ENV: "production",
          ODYSHELL_WEB_URL: "http://app.example",
        },
        true,
      ),
    ).toThrow(/HTTPS/);
    expect(
      cloudWebUrl(
        {
          NODE_ENV: "production",
          ODYSHELL_WEB_URL: "https://app.example/ignored",
        },
        true,
      ),
    ).toBe("https://app.example");
    expect(
      cloudWebUrl(
        {
          NODE_ENV: "production",
          ODYSHELL_WEB_URL: "http://localhost:3000",
        },
        true,
      ),
    ).toBe("http://localhost:3000");
  });

  it("denies cloud mutations when the internal web credential is missing or wrong", () => {
    const key = "a-secure-internal-web-key-with-32-characters";
    expect(cloudWebRequestDecision(undefined, key)).toBe("disabled");
    expect(cloudWebRequestDecision(key, undefined)).toBe("unauthorized");
    expect(cloudWebRequestDecision(key, "wrong-key")).toBe("unauthorized");
    expect(cloudWebRequestDecision(key, key)).toBe("authorized");
  });

  it("keeps cloud auth optional for self-hosted deployments", () => {
    expect(cloudWebKey({ NODE_ENV: "production" })).toBeUndefined();
    expect(cloudWebUrl({ NODE_ENV: "production" }, false)).toBeUndefined();
    expect(entitlementsFor("unknown")).toEqual({
      machineLimit: 2,
      workspaceLimit: 1,
      activeAgentLimit: 3,
    });
  });

  it("binds short-lived live streams to one workspace and rejects tampering or expiry", () => {
    const secret = "a-secure-internal-web-key-with-32-characters";
    const token = createCloudLiveToken(
      secret,
      { workspaceId: "workspace-a", userId: "user-a" },
      1_000,
      60_000,
    );

    expect(verifyCloudLiveToken(secret, token, 60_999)).toEqual({
      workspaceId: "workspace-a",
      userId: "user-a",
      expiresAt: 61_000,
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
    });
    expect(verifyCloudLiveToken(secret, token, 61_000)).toBeNull();
    expect(
      verifyCloudLiveToken(
        "a-different-internal-web-key-with-32-characters",
        token,
        2_000,
      ),
    ).toBeNull();
    const [tokenPayload, tokenSignature] = token
      .slice("ods_live_".length)
      .split(".");
    const changedSignature = `${tokenSignature![0] === "A" ? "B" : "A"}${tokenSignature!.slice(1)}`;
    expect(
      verifyCloudLiveToken(
        secret,
        `ods_live_${tokenPayload}.${changedSignature}`,
        2_000,
      ),
    ).toBeNull();

    const base64urlAlphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalIndex = base64urlAlphabet.indexOf(tokenSignature!.at(-1)!);
    const equivalentNonCanonicalSignature =
      tokenSignature!.slice(0, -1) + base64urlAlphabet[finalIndex ^ 1];
    expect(
      Buffer.from(equivalentNonCanonicalSignature, "base64url"),
    ).toEqual(Buffer.from(tokenSignature!, "base64url"));
    expect(
      verifyCloudLiveToken(
        secret,
        `ods_live_${tokenPayload}.${equivalentNonCanonicalSignature}`,
        2_000,
      ),
    ).toBeNull();
  });

  it("rejects replayed live-stream tokens and releases expired replay state", () => {
    const replayGuard = new CloudLiveTokenReplayGuard();
    const token = "ods_live_payload.signature";

    expect(replayGuard.consume(token, 61_000, 1_000)).toBe(true);
    expect(replayGuard.consume(token, 61_000, 1_001)).toBe(false);
    expect(replayGuard.consume(token, 122_000, 61_000)).toBe(true);
  });

  it("bounds concurrent live resources by both user and workspace", () => {
    const limiter = new ScopedConcurrencyLimiter(2, 1);

    expect(limiter.acquire("workspace-a", "user-a")).toBe(true);
    expect(limiter.acquire("workspace-a", "user-a")).toBe(false);
    expect(limiter.acquire("workspace-a", "user-b")).toBe(true);
    expect(limiter.acquire("workspace-a", "user-c")).toBe(false);
    limiter.release("workspace-a", "user-a");
    expect(limiter.acquire("workspace-a", "user-c")).toBe(true);
    limiter.release("workspace-a", "user-a");
    expect(limiter.activeForWorkspace("workspace-a")).toBe(2);
  });

  it("accepts live streams only from the exact configured web origin", () => {
    expect(
      cloudLiveOriginDecision(
        "https://odyshell.com",
        "https://odyshell.com",
      ),
    ).toBe("allowed");
    expect(
      cloudLiveOriginDecision(
        "https://odyshell.com",
        "https://odyshell.com.attacker.test",
      ),
    ).toBe("denied");
    expect(
      cloudLiveOriginDecision("https://odyshell.com", undefined),
    ).toBe("denied");
    expect(cloudLiveOriginDecision(undefined, "https://odyshell.com")).toBe(
      "disabled",
    );
  });

  it("rate-limits repeated device attempts and resets only after the window", () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000);
    expect(limiter.allow("client", 1_000)).toBe(true);
    expect(limiter.allow("client", 1_100)).toBe(true);
    expect(limiter.allow("client", 1_200)).toBe(false);
    expect(limiter.allow("other", 1_200)).toBe(true);
    expect(limiter.allow("client", 2_000)).toBe(true);
  });

  it("releases expired rate-limit keys before tracking new traffic", () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000);
    for (let index = 0; index < 1_000; index += 1) {
      expect(limiter.allow(`client-${index}`, 1_000)).toBe(true);
    }
    expect(limiter.trackedKeyCount).toBe(1_000);

    expect(limiter.allow("fresh-client", 2_000)).toBe(true);
    expect(limiter.trackedKeyCount).toBe(1);
  });

  it("fails closed when unique active rate-limit keys exhaust capacity", () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000, 3);
    expect(limiter.allow("client-a", 1_000)).toBe(true);
    expect(limiter.allow("client-b", 1_000)).toBe(true);
    expect(limiter.allow("client-c", 1_000)).toBe(true);

    for (let index = 0; index < 1_000; index += 1) {
      expect(limiter.allow(`attacker-${index}`, 1_001)).toBe(false);
    }
    expect(limiter.trackedKeyCount).toBe(3);
    expect(limiter.allow("client-a", 1_001)).toBe(true);
    expect(limiter.canAllow("bypass", 1_001)).toBe(false);
    limiter.consume("bypass", 1_001);
    expect(limiter.trackedKeyCount).toBe(3);

    expect(limiter.allow("fresh-client", 2_000)).toBe(true);
    expect(limiter.trackedKeyCount).toBe(1);
  });

  it("expires rolled-back windows without pinning capacity to a future timestamp", () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000, 2);
    expect(limiter.allow("future-client", 100_000)).toBe(true);
    expect(limiter.allow("rolled-back-client", 1_000)).toBe(true);

    expect(limiter.allow("fresh-client", 2_000)).toBe(true);
    expect(limiter.trackedKeyCount).toBe(2);
  });

  it("fails closed on invalid rate-limiter state and timestamps", () => {
    expect(() => new FixedWindowRateLimiter(0, 1_000)).toThrow(RangeError);
    expect(() => new FixedWindowRateLimiter(1, 0)).toThrow(RangeError);
    expect(() => new FixedWindowRateLimiter(1, 1_000, 0)).toThrow(RangeError);

    const limiter = new FixedWindowRateLimiter(1, 1_000);
    expect(limiter.allow("client", Number.NaN)).toBe(false);
    expect(limiter.allow("client", Number.POSITIVE_INFINITY)).toBe(false);
    expect(limiter.allow("client", Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(limiter.trackedKeyCount).toBe(0);
  });

  it("bounds credential issuance per member and workspace", () => {
    const perMember = new ScopedRateLimiter(4, 2, 1_000);
    expect(perMember.allow("workspace", "member-a", 1_000)).toBe(true);
    expect(perMember.allow("workspace", "member-a", 1_001)).toBe(true);
    expect(perMember.allow("workspace", "member-a", 1_002)).toBe(false);
    expect(perMember.allow("workspace", "member-a", 1_003)).toBe(false);
    expect(perMember.allow("workspace", "member-b", 1_004)).toBe(true);
    expect(perMember.allow("workspace", "member-b", 1_005)).toBe(true);
    expect(perMember.allow("workspace", "member-c", 1_006)).toBe(false);

    const perWorkspace = new ScopedRateLimiter(3, 3, 1_000);
    expect(perWorkspace.allow("workspace", "member-a", 1_000)).toBe(true);
    expect(perWorkspace.allow("workspace", "member-b", 1_001)).toBe(true);
    expect(perWorkspace.allow("workspace", "member-c", 1_002)).toBe(true);
    expect(perWorkspace.allow("workspace", "member-d", 1_003)).toBe(false);
    expect(perWorkspace.allow("other", "member-d", 1_003)).toBe(true);
  });

  it("rejects expired approval and prevents device-code replay", () => {
    const now = new Date("2026-07-30T10:00:00.000Z");
    const approved = {
      status: "approved",
      expiresAt: new Date("2026-07-30T10:10:00.000Z"),
      workspaceId: "workspace",
      userId: "user",
    };
    expect(deviceExchangeDecision(approved, now)).toBe("authorized");
    expect(deviceExchangeDecision({ ...approved, status: "consumed" }, now)).toBe(
      "consumed",
    );
    expect(
      deviceApprovalDecision(
        {
          ...approved,
          status: "pending",
          expiresAt: new Date("2026-07-30T09:59:59.000Z"),
        },
        now,
      ),
    ).toBe("expired");
    expect(
      deviceExchangeDecision({ ...approved, workspaceId: null }, now),
    ).toBe("consumed");
  });
});
