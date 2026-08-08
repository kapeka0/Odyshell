import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresControlDatabase } from "../src/control-database.js";

const connectionString = process.env.DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("PostgreSQL control boundary", () => {
  const externalId = `org-${randomUUID()}`;
  const secondExternalId = `org-${randomUUID()}`;
  let database: PostgresControlDatabase;
  let workspaceId: string;
  let organizationId: string;
  let secondWorkspaceId: string;

  beforeAll(async () => {
    database = new PostgresControlDatabase(connectionString!, "cloud");
    await database.initialize();
    const primary = await database.ensureCloudContext({
      externalId,
      slug: `org-${randomUUID()}`,
      name: "Control Test",
      userName: "Karim Test",
    });
    workspaceId = primary.workspace.id;
    organizationId = primary.organization.id;
    const second = await database.ensureCloudContext({
      externalId: secondExternalId,
      slug: `org-${randomUUID()}`,
      name: "Other Control Test",
    });
    secondWorkspaceId = second.workspace.id;
  });

  afterAll(async () => {
    const pool = new pg.Pool({ connectionString });
    for (const selectedWorkspace of [workspaceId, secondWorkspaceId]) {
      await pool.query("delete from odyshell.audit_events where workspace_id = $1", [selectedWorkspace]);
      await pool.query("delete from odyshell.notifications where workspace_id = $1", [selectedWorkspace]);
      await pool.query("delete from odyshell.enrollment_tokens where workspace_id = $1", [selectedWorkspace]);
      await pool.query("delete from odyshell.mcp_installations where workspace_id = $1", [selectedWorkspace]);
      await pool.query("delete from odyshell.agents where workspace_id = $1", [selectedWorkspace]);
      await pool.query("delete from odyshell.machines where workspace_id = $1", [selectedWorkspace]);
      await pool.query("delete from odyshell.workspaces where id = $1", [selectedWorkspace]);
    }
    await pool.query("delete from odyshell.organizations where external_id = any($1::text[])", [
      [externalId, secondExternalId],
    ]);
    await pool.end();
    await database.close();
  });

  it("keeps one sovereign workspace per Organization identity", async () => {
    const context = await database.ensureCloudContext({
      externalId,
      slug: "ignored-after-creation",
      name: "Renamed Control Test",
      userName: "Karim Test",
    });
    expect(context.organization).toMatchObject({ id: organizationId, name: "Renamed Control Test" });
    expect(context.workspace).toMatchObject({ id: workspaceId, name: "Karim's Workspace" });
    expect(await database.mcpWorkspacesForOrganizations([secondExternalId])).toEqual([
      expect.objectContaining({ workspaceId: secondWorkspaceId }),
    ]);
  });

  it("rejects a second self-hosted Organization", async () => {
    const selfHosted = new PostgresControlDatabase(connectionString!, "self-hosted");
    await expect(selfHosted.ensureCloudContext({
      externalId: `forbidden-${randomUUID()}`,
      slug: `forbidden-${randomUUID()}`,
      name: "Forbidden tenant",
    })).rejects.toThrow("exactly one Organization");
    await selfHosted.close();
  });

  it("consumes enrollment tokens once and fail-closes replacement races", async () => {
    const firstToken = `token-${randomUUID()}`;
    const machineId = randomUUID();
    await database.createEnrollmentToken(workspaceId, firstToken, Date.now() + 60_000, "human-a");
    await expect(database.enrollMachine({
      tokenHash: firstToken,
      machineId,
      name: "worker-a",
      publicKey: "public-key-a",
    })).resolves.toMatchObject({ status: "enrolled", organizationId: externalId });
    await expect(database.enrollMachine({
      tokenHash: firstToken,
      machineId: randomUUID(),
      name: "replay",
      publicKey: "public-key-b",
    })).resolves.toBeNull();

    const replacementToken = `token-${randomUUID()}`;
    await database.createEnrollmentToken(
      workspaceId,
      replacementToken,
      Date.now() + 60_000,
      "human-a",
    );
    await expect(database.enrollMachine({
      tokenHash: replacementToken,
      machineId: randomUUID(),
      previousMachineId: machineId,
      name: "replacement",
      publicKey: "public-key-c",
    })).resolves.toEqual({ status: "previous_machine_active", workspaceId });
    expect(await database.revokeMachine(workspaceId, machineId)).toMatchObject({ id: machineId });
    await expect(database.enrollMachine({
      tokenHash: replacementToken,
      machineId: randomUUID(),
      previousMachineId: machineId,
      name: "replacement",
      publicKey: "public-key-c",
    })).resolves.toMatchObject({ status: "enrolled" });
  });

  it("binds MCP Agents to an OAuth installation and enforces the plan limit", async () => {
    const installations = [];
    for (let index = 0; index < 3; index += 1) {
      installations.push(await database.ensureMcpInstallation({
        workspaceId,
        userId: `human-${index}`,
        oauthClientId: `oauth-${index}`,
        agentName: `Agent ${index}`,
      }));
    }
    expect(installations).toHaveLength(3);
    await expect(database.ensureMcpInstallation({
      workspaceId,
      userId: "human-full",
      oauthClientId: "oauth-full",
      agentName: "Blocked Agent",
    })).resolves.toMatchObject({
      status: "agent_limit_reached",
      plan: "free",
      activeAgentLimit: 3,
    });
    const first = installations[0];
    if (!first || first.status === "agent_limit_reached") throw new Error("Agent was not installed");
    expect(await database.deleteWorkspaceAgent(workspaceId, first.agentId)).toEqual({
      agentIds: [first.agentId],
    });
    await expect(database.ensureMcpInstallation({
      workspaceId,
      userId: first.userId,
      oauthClientId: first.oauthClientId,
      agentName: first.agentName,
    })).resolves.toBeNull();
  });

  it("scopes audit and Machine identity lookups without leaking metadata", async () => {
    await database.audit(workspaceId, "human-a", "machine.updated", "machine", "machine-a", {
      safe: true,
    });
    expect(await database.listAudit(secondWorkspaceId, 10)).toEqual([]);
    expect(await database.listAudit(workspaceId, 10)).toEqual([
      expect.objectContaining({
        principalId: "human-a",
        action: "machine.updated",
        metadata: { safe: true },
      }),
    ]);
    expect(await database.machinePublicKey(randomUUID())).toBeNull();
  });
});
