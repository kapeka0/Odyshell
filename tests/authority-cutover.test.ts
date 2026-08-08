import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Task-native authority cutover", () => {
  it("does not register superseded authority routes", () => {
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );
    for (const route of [
      "/v1/sessions",
      "/v1/operations",
      "/v1/development/sessions",
      "/v1/agent-session-requests",
      "/v1/managed-agents",
      "/v1/admin/workspaces",
      "/v1/admin/event-sink",
    ]) {
      expect(server).not.toContain(route);
    }
  });

  it("accepts only Task protocol data after Machine authentication", () => {
    const gateway = readFileSync(
      resolve(process.cwd(), "apps/server/src/gateway.ts"),
      "utf8",
    );
    const protocol = readFileSync(
      resolve(process.cwd(), "packages/protocol/src/index.ts"),
      "utf8",
    );
    expect(protocol).toContain("clientMessageSchema.parse(JSON.parse(raw))");
    expect(protocol).toContain("taskProfile: {");
    expect(protocol).not.toContain('type: "session.open"');
    expect(protocol).not.toContain('type: "operation.start"');
    expect(gateway).not.toContain('case "session.opened"');
    expect(gateway).not.toContain('case "operation.completed"');
  });
});
