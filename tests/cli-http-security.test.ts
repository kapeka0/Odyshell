import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerCliHttp } from "../apps/server/src/cli-http.js";

function appFor(identity: object | null) {
  const app = Fastify();
  const database = {
    organizationByExternalId: vi.fn(async (externalId: string) => ({
      id: "control-org-a", externalId, name: "A", slug: "a", plan: "free",
    })),
    listMachines: vi.fn(async () => []),
    listOrganizationAgents: vi.fn(async () => []),
    organizationPlan: vi.fn(async () => null),
    activeMachinesExist: vi.fn(async () => false),
    updateOrganizationAgentRole: vi.fn(),
    deleteOrganizationAgent: vi.fn(),
    audit: vi.fn(),
  };
  registerCliHttp(app, {
    authenticate: vi.fn(async () => identity as any),
    database: database as any,
    sessionDatabase: {
      listSessions: vi.fn(async () => []),
      sessionTimeline: vi.fn(async () => null),
      revokeSessions: vi.fn(async () => []),
    } as any,
    gateway: {
      isOnline: vi.fn(() => false), send: vi.fn(), ping: vi.fn(), notifyOrganization: vi.fn(),
    } as any,
    service: { superviseSession: vi.fn() } as any,
  });
  return { app, database };
}

describe("Human CLI HTTP authorization", () => {
  it("rejects missing OAuth before touching tenant data", async () => {
    const { app, database } = appFor(null);
    const response = await app.inject({ method: "GET", url: "/v1/cli/context" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(database.organizationByExternalId).not.toHaveBeenCalled();
    await app.close();
  });

  it("denies Agent role elevation to a Supervisor", async () => {
    const { app, database } = appFor({
      humanId: "human-a", clientId: "cli-a", organizationId: "org-a", role: "supervisor",
    });
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/cli/agents/7a354999-6a6c-42db-9467-e1416da255f1/role",
      payload: { role: "operator" },
    });
    expect(response.statusCode).toBe(403);
    expect(database.updateOrganizationAgentRole).not.toHaveBeenCalled();
    await app.close();
  });

  it("binds context reads to the Organization claim", async () => {
    const { app, database } = appFor({
      humanId: "human-a", clientId: "cli-a", organizationId: "org-from-token", role: "admin",
    });
    const response = await app.inject({ method: "GET", url: "/v1/cli/context" });
    expect(response.statusCode).toBe(200);
    expect(database.organizationByExternalId).toHaveBeenCalledWith("org-from-token");
    expect(database.listMachines).toHaveBeenCalledWith("control-org-a");
    await app.close();
  });
});
