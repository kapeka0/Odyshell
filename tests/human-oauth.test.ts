import { describe, expect, it } from "vitest";
import { humanOAuthIdentityFromClaims } from "../apps/server/src/human-oauth.js";

const validClaims = {
  sub: "human-a",
  azp: "cli-a",
  scope: "openid odyshell:cli",
  organization_id: "org-a",
  organization_role: "admin",
};

describe("Human CLI OAuth boundary", () => {
  it("accepts only a signed-shape Organization Human with the CLI scope", () => {
    expect(humanOAuthIdentityFromClaims(validClaims)).toEqual({
      humanId: "human-a",
      clientId: "cli-a",
      organizationId: "org-a",
      role: "admin",
    });
    expect(humanOAuthIdentityFromClaims({ ...validClaims, scope: "odyshell:agent" })).toBeNull();
    expect(humanOAuthIdentityFromClaims({ ...validClaims, organization_id: undefined })).toBeNull();
  });

  it("rejects Agent roles and unknown elevated Human roles", () => {
    expect(humanOAuthIdentityFromClaims({ ...validClaims, organization_role: "operator" })).toBeNull();
    expect(humanOAuthIdentityFromClaims({ ...validClaims, organization_role: "ownerish" })).toBeNull();
  });
});
