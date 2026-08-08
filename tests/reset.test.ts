import { describe, expect, it } from "vitest";
import { resetLocalOdyshell } from "../apps/cli/src/reset.js";

describe("ods reset", () => {
  it("removes every local Client Profile", async () => {
    const result = await resetLocalOdyshell({
      removeProfiles: async () => ({
        removed: [
          { profileName: "work", configPath: "/profiles/work/client.json" },
        ],
      }),
    });

    expect(result).toEqual({ removedProfiles: ["work"] });
  });

  it("fails closed when a Client service cannot be removed", async () => {
    await expect(
      resetLocalOdyshell({
        removeProfiles: async () => {
          throw new Error("service manager unavailable");
        },
      }),
    ).rejects.toThrow("service manager unavailable");
  });
});
