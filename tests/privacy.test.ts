import { describe, expect, it } from "vitest";
import { dataRetentionPolicy } from "../apps/server/src/privacy.js";

describe("server privacy defaults", () => {
  it("retains timeline output and audit for 30 days by default", () => {
    expect(dataRetentionPolicy({})).toEqual({
      commandOutputMilliseconds: 30 * 24 * 60 * 60 * 1_000,
      auditMilliseconds: 30 * 24 * 60 * 60 * 1_000,
    });
  });

  it("accepts bounded customer-controlled retention", () => {
    expect(
      dataRetentionPolicy({
        ODYSHELL_COMMAND_OUTPUT_RETENTION_DAYS: "1",
        ODYSHELL_AUDIT_RETENTION_DAYS: "1",
      }),
    ).toEqual({
      commandOutputMilliseconds: 24 * 60 * 60 * 1_000,
      auditMilliseconds: 24 * 60 * 60 * 1_000,
    });
  });

  it.each([
    ["ODYSHELL_COMMAND_OUTPUT_RETENTION_DAYS", "0"],
    ["ODYSHELL_COMMAND_OUTPUT_RETENTION_DAYS", "366"],
    ["ODYSHELL_COMMAND_OUTPUT_RETENTION_DAYS", "not-a-number"],
    ["ODYSHELL_AUDIT_RETENTION_DAYS", "0"],
    ["ODYSHELL_AUDIT_RETENTION_DAYS", "3651"],
  ])("fails closed for invalid %s values", (name, value) => {
    expect(() => dataRetentionPolicy({ [name]: value })).toThrow(name);
  });
});
