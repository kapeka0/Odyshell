import { describe, expect, it } from "vitest";
import { dataRetentionPolicy } from "../apps/server/src/privacy.js";

describe("server privacy defaults", () => {
  it("uses short-lived operation payloads and bounded audit retention", () => {
    expect(dataRetentionPolicy({})).toEqual({
      operationDataMilliseconds: 60 * 60 * 1_000,
      auditMilliseconds: 30 * 24 * 60 * 60 * 1_000,
    });
  });

  it("accepts bounded customer-controlled retention", () => {
    expect(
      dataRetentionPolicy({
        ODYSHELL_OPERATION_RETENTION_SECONDS: "60",
        ODYSHELL_AUDIT_RETENTION_DAYS: "1",
      }),
    ).toEqual({
      operationDataMilliseconds: 60 * 1_000,
      auditMilliseconds: 24 * 60 * 60 * 1_000,
    });
  });

  it.each([
    ["ODYSHELL_OPERATION_RETENTION_SECONDS", "0"],
    ["ODYSHELL_OPERATION_RETENTION_SECONDS", "-1"],
    ["ODYSHELL_OPERATION_RETENTION_SECONDS", "not-a-number"],
    ["ODYSHELL_AUDIT_RETENTION_DAYS", "0"],
    ["ODYSHELL_AUDIT_RETENTION_DAYS", "3651"],
  ])("fails closed for invalid %s values", (name, value) => {
    expect(() => dataRetentionPolicy({ [name]: value })).toThrow(name);
  });
});
