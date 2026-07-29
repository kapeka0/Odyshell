import { describe, expect, it } from "vitest";
import { assertClientUpConfiguration } from "../apps/cli/src/up.js";

describe("ods up configuration safety", () => {
  it("refuses to ignore enrollment options for an existing identity", () => {
    expect(() =>
      assertClientUpConfiguration({
        configExists: true,
        enrollmentRequested: true,
        configPath: "/home/ada/.config/odyshell/client.json",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "client_already_enrolled",
        expected: true,
      }),
    );
  });

  it("does not include enrollment credentials in the conflict error", () => {
    let message = "";
    try {
      assertClientUpConfiguration({
        configExists: true,
        enrollmentRequested: true,
        configPath: "/home/ada/.config/odyshell/client.json",
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("Refusing to ignore or overwrite");
    expect(message).not.toMatch(/ods_(?:enroll|agent)_/);
  });

  it("starts existing identities without enrollment options and permits fresh enrollment", () => {
    expect(() =>
      assertClientUpConfiguration({
        configExists: true,
        enrollmentRequested: false,
        configPath: "/home/ada/.config/odyshell/client.json",
      }),
    ).not.toThrow();
    expect(() =>
      assertClientUpConfiguration({
        configExists: false,
        enrollmentRequested: true,
        configPath: "/home/ada/.config/odyshell/railway-client.json",
      }),
    ).not.toThrow();
  });
});
