import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresControlDatabase } from "../src/control-database.js";

const connectionString = process.env.DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("PostgreSQL Organization control boundary", () => {
  const externalId = `org-${randomUUID()}`;
  let database: PostgresControlDatabase;
  let organizationId: string;

  beforeAll(async () => {
    database = new PostgresControlDatabase(connectionString!);
    await database.initialize();
    const primary = await database.ensureControlContext({
      externalId,
      slug: `org-${randomUUID()}`,
      name: "Control Test",
    });
    organizationId = primary.organization.id;
  });

  afterAll(async () => {
    const pool = new pg.Pool({ connectionString });
    await pool.query(
      "delete from odyshell.organizations where external_id = $1",
      [externalId],
    );
    await pool.end();
    await database.close();
  });

  it("creates no Workspace table or foreign-key columns", async () => {
    const pool = new pg.Pool({ connectionString });
    try {
      const table = await pool.query<{ relation: string | null }>(
        "select to_regclass('odyshell.workspaces')::text as relation",
      );
      const columns = await pool.query<{ count: string }>(`
        select count(*) from information_schema.columns
        where table_schema = 'odyshell' and column_name = 'workspace_id'
      `);
      expect(table.rows[0]?.relation).toBeNull();
      expect(Number(columns.rows[0]?.count)).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("maps each external identity to one Organization tenant", async () => {
    const context = await database.ensureControlContext({
      externalId,
      slug: "renamed-control-test",
      name: "Renamed Control Test",
    });
    expect(context.organization).toMatchObject({
      id: organizationId,
      slug: "renamed-control-test",
      name: "Renamed Control Test",
    });
    expect(await database.mcpOrganizations([externalId])).toEqual([
      expect.objectContaining({ organizationId }),
    ]);
  });

  it("rejects a second self-hosted Organization", async () => {
    await expect(database.ensureControlContext({
      externalId: `forbidden-${randomUUID()}`,
      slug: `forbidden-${randomUUID()}`,
      name: "Forbidden tenant",
    })).rejects.toThrow("exactly one Organization");
  });

  it("consumes enrollment tokens once and fail-closes replacement races", async () => {
    const firstToken = `token-${randomUUID()}`;
    const machineId = randomUUID();
    await database.createEnrollmentToken(
      organizationId,
      firstToken,
      Date.now() + 60_000,
      "human-a",
    );
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
      organizationId,
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
    })).resolves.toEqual({ status: "previous_machine_active" });
    expect(await database.revokeMachine(organizationId, machineId)).toMatchObject({
      id: machineId,
    });
    await expect(database.enrollMachine({
      tokenHash: replacementToken,
      machineId: randomUUID(),
      previousMachineId: machineId,
      name: "replacement",
      publicKey: "public-key-c",
    })).resolves.toMatchObject({ status: "enrolled" });
  });

  it("binds unlimited MCP Agents to OAuth", async () => {
    const installations = [];
    for (let index = 0; index < 3; index += 1) {
      installations.push(await database.ensureMcpInstallation({
        organizationId,
        userId: `human-${index}`,
        oauthClientId: `oauth-${index}`,
        agentName: `Agent ${index}`,
      }));
    }
    await expect(database.ensureMcpInstallation({
      organizationId,
      userId: "human-full",
      oauthClientId: "oauth-full",
      agentName: "Fourth Agent",
    })).resolves.toMatchObject({ status: "active" });
    const first = installations[0];
    if (!first) {
      throw new Error("Agent was not installed");
    }
    expect(await database.deleteOrganizationAgent(
      organizationId,
      first.agentId,
    )).toEqual({ agentIds: [first.agentId] });
    await expect(database.ensureMcpInstallation({
      organizationId,
      userId: first.userId,
      oauthClientId: first.oauthClientId,
      agentName: first.agentName,
    })).resolves.toBeNull();
  });

  it("isolates audit and Machine identity lookups by Organization", async () => {
    await database.audit(
      organizationId,
      "human-a",
      "machine.updated",
      "machine",
      "machine-a",
      { safe: true },
    );
    expect(await database.listAudit(randomUUID(), 10)).toEqual([]);
    expect(await database.listAudit(organizationId, 10)).toEqual([
      expect.objectContaining({
        principalId: "human-a",
        action: "machine.updated",
        metadata: { safe: true },
      }),
    ]);
    expect(await database.machinePublicKey(randomUUID())).toBeNull();
  });
});
