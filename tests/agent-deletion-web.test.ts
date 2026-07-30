import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("agent deletion web boundary", () => {
  it("requires confirmation and authenticated UUID-scoped routing", () => {
    const webRoot = resolve(process.cwd(), "apps/web/src");
    const agentList = readFileSync(
      resolve(webRoot, "components/agent-access-manager.tsx"),
      "utf8",
    );
    const agentRoute = readFileSync(
      resolve(webRoot, "app/api/agent-access/[tokenId]/route.ts"),
      "utf8",
    );

    expect(agentList).toContain("openDeleteDialog");
    expect(agentList).toContain("Delete {access.name}?");
    expect(agentList).toContain("This cannot be undone.");
    expect(agentList).toContain('method: "DELETE"');
    expect(agentRoute).toContain("requireCloudRouteIdentity()");
    expect(agentRoute).toContain("z.string().uuid()");
    expect(agentRoute).toContain('mutateAgentAccess("delete"');
  });
});
