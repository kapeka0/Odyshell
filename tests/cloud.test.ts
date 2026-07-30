import { describe, expect, it } from "vitest";
import {
  createCloudAgentAccessSchema,
  cloudIdentitySchema,
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
  ScopedRateLimiter,
} from "../apps/server/src/cloud.js";
import { cloudRouteIdentityDecision } from "../apps/web/src/lib/cloud-route-policy.js";

describe("cloud identity and device authorization boundaries", () => {
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
        organization: { externalId: "org", slug: "../escape", name: "Acme" },
      }).success,
    ).toBe(false);
    expect(
      cloudIdentitySchema.safeParse({
        userId: "",
        organization: { externalId: "org", slug: "acme", name: "Acme" },
      }).success,
    ).toBe(false);
  });

  it("binds cloud mutations to the authenticated identity instead of client workspace input", () => {
    const identity = {
      userId: "user_123",
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
      revokeCloudMachineSchema.safeParse({
        ...identity,
        machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
        workspaceId: "attacker-workspace",
      }).success,
    ).toBe(false);
  });

  it("never exposes operation content through cloud control events", () => {
    const machineId = "2dc24de7-ec0e-45b3-88c1-acbb900e51f8";
    expect(
      privacySafeControlMetadata({
        kind: "process.exec",
        reason: "machine_scope",
        machineId,
        command: "cat /etc/shadow",
        path: "/etc/shadow",
        stdout: "secret",
        stderr: "secret",
      }),
    ).toEqual({
      kind: "process.exec",
      reason: "machine_scope",
      machineId,
    });
  });

  it("drops attacker-controlled control metadata even when it uses safe field names", () => {
    expect(
      privacySafeControlMetadata({
        kind: "cat /etc/shadow",
        reason: "secret copied from stdout",
        machineId: "../../private-machine",
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

  it("rate-limits repeated device attempts and resets only after the window", () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000);
    expect(limiter.allow("client", 1_000)).toBe(true);
    expect(limiter.allow("client", 1_100)).toBe(true);
    expect(limiter.allow("client", 1_200)).toBe(false);
    expect(limiter.allow("other", 1_200)).toBe(true);
    expect(limiter.allow("client", 2_000)).toBe(true);
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
