import { describe, expect, it } from "vitest";
import { operationRequestSchema, sessionRequestSchema } from "../packages/protocol/src/index.js";

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

  it("rejects excessive session leases", () => {
    expect(
      sessionRequestSchema.safeParse({
        machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
        ttlSeconds: 7200,
        capabilities: ["process.exec"],
      }).success,
    ).toBe(false);
  });
});
