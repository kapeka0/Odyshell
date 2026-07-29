import { describe, expect, it } from "vitest";
import { resolveMachineReference } from "../apps/cli/src/machines.js";

const machines = [
  { id: "active-id", name: "raspberry", online: true, revokedAt: null },
  { id: "offline-id", name: "desktop", online: false, revokedAt: null },
  {
    id: "revoked-id",
    name: "old-server",
    online: false,
    revokedAt: "2026-07-29T18:00:00.000Z",
  },
];

describe("machine reference resolution", () => {
  it("resolves active machines by case-insensitive name or exact ID", () => {
    expect(resolveMachineReference(machines, "RASPBERRY").id).toBe("active-id");
    expect(resolveMachineReference(machines, "offline-id").name).toBe("desktop");
  });

  it("fails closed for revoked and offline machine access", () => {
    expect(() => resolveMachineReference(machines, "old-server")).toThrowError(
      expect.objectContaining({ code: "machine_revoked" }),
    );
    expect(() =>
      resolveMachineReference(machines, "desktop", { requireOnline: true }),
    ).toThrowError(expect.objectContaining({ code: "machine_offline" }));
  });

  it("requires an ID when active names are ambiguous", () => {
    const duplicate = { id: "duplicate-id", name: "raspberry", online: true, revokedAt: null };
    expect(() => resolveMachineReference([...machines, duplicate], "raspberry")).toThrowError(
      expect.objectContaining({ code: "machine_ambiguous" }),
    );
    expect(resolveMachineReference([...machines, duplicate], "duplicate-id")).toBe(duplicate);
  });
});
