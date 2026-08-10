import { randomUUID } from "node:crypto";
import pg, { type PoolClient, type QueryResultRow } from "pg";
import { type OrganizationLoggingLevel } from "./control.js";

const { Pool } = pg;
const CONTROL_MIGRATION_LOCK = 1_781_239_411;

export type OrganizationRecord = {
  id: string;
  slug: string;
  name: string;
  externalId: string;
  avatarSeed: string;
  loggingLevel: OrganizationLoggingLevel;
  createdAt: number;
};

export type UserPreferenceRecord = {
  externalId: string;
  timeZone: string;
  updatedAt: number;
};

export type NotificationRecord = {
  id: string;
  kind: "machine.enrolled" | "machine.offline" | "agent.revoked";
  title: string;
  description: string;
  href: string;
  readAt?: number;
  createdAt: number;
};

export type MachineRecord = {
  id: string;
  name: string;
  description?: string;
  publicKey: string;
  status: string;
  runtime?: unknown;
  lastSeenAt?: number;
  enrolledAt: number;
  revokedAt?: number;
};

export type AgentIdentityRecord = {
  organizationId: string;
  id: string;
  name: string;
  role: "standard" | "operator";
  createdByHumanId?: string;
  status: "active" | "disabled";
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type McpInstallationRecord = {
  organizationId: string;
  id: string;
  userId: string;
  oauthClientId: string;
  agentId: string;
  agentName: string;
  agentRole: "standard" | "operator";
  status: "active" | "revoked";
  createdAt: number;
  updatedAt: number;
};

export type McpOrganizationRecord = {
  organizationId: string;
  organizationName: string;
  organizationExternalId: string;
};

export type AuditRecord = {
  id: string;
  principalId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
};

type OrganizationRow = QueryResultRow & {
  id: string;
  slug: string;
  name: string;
  external_id: string;
  avatar_seed: string;
  logging_level: OrganizationLoggingLevel;
  created_at: Date;
};

type MachineRow = QueryResultRow & {
  id: string;
  name: string;
  description: string | null;
  public_key: string;
  status: string;
  runtime: unknown | null;
  last_seen_at: Date | null;
  enrolled_at: Date;
  revoked_at: Date | null;
};

type AgentRow = QueryResultRow & {
  organization_id: string;
  id: string;
  name: string;
  role: "standard" | "operator";
  created_by_human_id: string | null;
  status: "active" | "disabled";
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export class PostgresControlDatabase {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 10_000,
    });
  }

  async initialize(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock($1)", [CONTROL_MIGRATION_LOCK]);
      await client.query(controlSchemaSql);
    });
    await this.pool.query(
      "update odyshell.machines set status = 'offline' where status <> 'offline'",
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async health(): Promise<void> {
    await this.pool.query("select 1");
  }

  async ensureControlContext(input: {
    externalId: string;
    slug: string;
    name: string;
  }): Promise<{ organization: OrganizationRecord }> {
    return await this.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [input.externalId]);
      const existingOrganization = await client.query<OrganizationRow>(
        "select * from odyshell.organizations where external_id = $1",
        [input.externalId],
      );
      if (existingOrganization.rows.length === 0) {
        const existingTenant = await client.query("select 1 from odyshell.organizations limit 1");
        if ((existingTenant.rowCount ?? 0) > 0) {
          throw new Error("Self-hosted Odyshell permits exactly one Organization");
        }
      }
      const organizationResult = await client.query<OrganizationRow>(`
        insert into odyshell.organizations (id, slug, name, external_id)
        values ($1, $2, $3, $4)
        on conflict (external_id) do update set
          slug = excluded.slug,
          name = excluded.name
        returning *
      `, [randomUUID(), input.slug, input.name, input.externalId]);
      return {
        organization: organizationRecord(organizationResult.rows[0]!),
      };
    });
  }

  async organizationUsage(organizationId: string): Promise<{
    activeMachines: number;
    activeAgents: number;
  } | null> {
    const result = await this.pool.query<{
      active_machines: string;
      active_agents: string;
    }>(`
      select (select count(*) from odyshell.machines machine
          where machine.organization_id = organization.id and machine.revoked_at is null) as active_machines,
        (select count(*) from odyshell.agents agent
          where agent.organization_id = organization.id and agent.deleted_at is null
            and agent.status = 'active') as active_agents
      from odyshell.organizations organization
      where organization.id = $1
    `, [organizationId]);
    const row = result.rows[0];
    return row ? {
      activeMachines: Number(row.active_machines),
      activeAgents: Number(row.active_agents),
    } : null;
  }

  async mcpOrganization(organizationId: string): Promise<McpOrganizationRecord | null> {
    const result = await this.pool.query<{
      organization_id: string;
      organization_name: string;
      organization_external_id: string;
    }>(`
      select id as organization_id, name as organization_name,
        external_id as organization_external_id
      from odyshell.organizations
      where id = $1
    `, [organizationId]);
    return result.rows[0] ? mcpOrganizationRecord(result.rows[0]) : null;
  }

  async organizationByExternalId(externalId: string): Promise<OrganizationRecord | null> {
    const result = await this.pool.query<OrganizationRow>(
      "select * from odyshell.organizations where external_id = $1",
      [externalId],
    );
    return result.rows[0] ? organizationRecord(result.rows[0]) : null;
  }

  async mcpOrganizations(externalIds: string[]): Promise<McpOrganizationRecord[]> {
    if (externalIds.length === 0) return [];
    const result = await this.pool.query<{
      organization_id: string;
      organization_name: string;
      organization_external_id: string;
    }>(`
      select id as organization_id, name as organization_name,
        external_id as organization_external_id
      from odyshell.organizations
      where external_id = any($1::text[])
      order by created_at
    `, [externalIds]);
    return result.rows.map(mcpOrganizationRecord);
  }

  async userPreferences(externalId: string): Promise<UserPreferenceRecord> {
    const result = await this.pool.query<{
      external_id: string;
      time_zone: string;
      updated_at: Date;
    }>("select * from odyshell.user_preferences where external_id = $1", [externalId]);
    const row = result.rows[0];
    return row ? {
      externalId: row.external_id,
      timeZone: row.time_zone,
      updatedAt: timestamp(row.updated_at),
    } : { externalId, timeZone: "System", updatedAt: 0 };
  }

  async upsertUserPreferences(input: {
    externalId: string;
    timeZone: string;
  }): Promise<UserPreferenceRecord> {
    const result = await this.pool.query<{
      external_id: string;
      time_zone: string;
      updated_at: Date;
    }>(`
      insert into odyshell.user_preferences (external_id, time_zone)
      values ($1, $2)
      on conflict (external_id) do update set time_zone = excluded.time_zone, updated_at = now()
      returning *
    `, [input.externalId, input.timeZone]);
    const row = result.rows[0]!;
    return { externalId: row.external_id, timeZone: row.time_zone, updatedAt: timestamp(row.updated_at) };
  }

  async updateOrganizationSettings(input:
    | { organizationId: string; section: "details"; name: string; avatarSeed: string }
    | { organizationId: string; section: "logging"; loggingLevel: OrganizationLoggingLevel }
  ): Promise<OrganizationRecord | null> {
    const result = input.section === "details"
      ? await this.pool.query<OrganizationRow>(`
          update odyshell.organizations set name = $2, avatar_seed = $3
          where id = $1 returning *
        `, [input.organizationId, input.name, input.avatarSeed])
      : await this.pool.query<OrganizationRow>(`
          update odyshell.organizations set logging_level = $2
          where id = $1 returning *
        `, [input.organizationId, input.loggingLevel]);
    return result.rows[0] ? organizationRecord(result.rows[0]) : null;
  }

  async createNotification(input: {
    organizationId: string;
    userId: string;
    kind: NotificationRecord["kind"];
    title: string;
    description?: string;
    href: string;
    resourceId: string;
  }): Promise<void> {
    await this.pool.query(`
      insert into odyshell.notifications
        (organization_id, id, user_id, kind, title, description, href, resource_id)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      input.organizationId, randomUUID(), input.userId, input.kind, input.title,
      input.description ?? "", input.href, input.resourceId,
    ]);
  }

  async listNotifications(organizationId: string, userId: string, limit = 50): Promise<NotificationRecord[]> {
    await this.pool.query(
      "delete from odyshell.notifications where created_at < now() - interval '30 days'",
    );
    const result = await this.pool.query<{
      id: string; kind: NotificationRecord["kind"]; title: string; description: string;
      href: string; read_at: Date | null; created_at: Date;
    }>(`
      select id, kind, title, description, href, read_at, created_at
      from odyshell.notifications where organization_id = $1 and user_id = $2
      order by created_at desc limit $3
    `, [organizationId, userId, Math.min(Math.max(limit, 1), 100)]);
    return result.rows.map((row) => ({
      id: row.id, kind: row.kind, title: row.title, description: row.description,
      href: row.href, ...(row.read_at ? { readAt: timestamp(row.read_at) } : {}),
      createdAt: timestamp(row.created_at),
    }));
  }

  async markNotificationRead(
    organizationId: string,
    userId: string,
    notificationId: string,
    read = true,
  ): Promise<boolean> {
    const result = await this.pool.query(`
      update odyshell.notifications set read_at = $4
      where organization_id = $1 and user_id = $2 and id = $3 returning id
    `, [organizationId, userId, notificationId, read ? new Date() : null]);
    return result.rowCount === 1;
  }

  async markAllNotificationsRead(organizationId: string, userId: string): Promise<number> {
    const result = await this.pool.query(`
      update odyshell.notifications set read_at = now()
      where organization_id = $1 and user_id = $2 and read_at is null returning id
    `, [organizationId, userId]);
    return result.rowCount ?? 0;
  }

  async ensureMcpInstallation(input: {
    organizationId: string;
    userId: string;
    oauthClientId: string;
    agentName: string;
  }): Promise<McpInstallationRecord | null> {
    return await this.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [input.organizationId]);
      const existing = await activeInstallation(client, input);
      if (existing) return existing;
      const revoked = await client.query(`
        select 1 from odyshell.mcp_installations
        where organization_id = $1 and provider = 'odyshell_identity'
          and user_id = $2 and oauth_client_id = $3
      `, [input.organizationId, input.userId, input.oauthClientId]);
      if ((revoked.rowCount ?? 0) > 0) return null;
      const now = new Date();
      const agentId = randomUUID();
      await client.query(`
        insert into odyshell.agents
          (organization_id, id, name, role, created_by_human_id, status, created_at, updated_at)
        values ($1, $2, $3, 'standard', $4, 'active', $5, $5)
      `, [input.organizationId, agentId, input.agentName, input.userId, now]);
      const result = await client.query<{
        organization_id: string; id: string; user_id: string; oauth_client_id: string;
        agent_id: string; status: "active"; created_at: Date; updated_at: Date;
      }>(`
        insert into odyshell.mcp_installations
          (organization_id, id, provider, user_id, oauth_client_id, agent_id, status, created_at, updated_at)
        values ($1, $2, 'odyshell_identity', $3, $4, $5, 'active', $6, $6)
        returning *
      `, [input.organizationId, randomUUID(), input.userId, input.oauthClientId, agentId, now]);
      return installationRecord(result.rows[0]!, input.agentName);
    });
  }

  async listOrganizationAgents(organizationId: string): Promise<AgentIdentityRecord[]> {
    const result = await this.pool.query<AgentRow>(`
      select * from odyshell.agents where organization_id = $1 and deleted_at is null
      order by created_at desc
    `, [organizationId]);
    return result.rows.map(agentRecord);
  }

  async listRunnableAgentIds(organizationId: string): Promise<string[]> {
    const result = await this.pool.query<{ agent_id: string }>(`
      select distinct installation.agent_id
      from odyshell.mcp_installations installation
      join odyshell.agents agent
        on agent.organization_id = installation.organization_id and agent.id = installation.agent_id
      where installation.organization_id = $1 and installation.status = 'active'
        and agent.status = 'active' and agent.deleted_at is null
    `, [organizationId]);
    return result.rows.map((row) => row.agent_id);
  }

  async deleteOrganizationAgent(organizationId: string, agentId: string): Promise<{
    agentIds: string[];
  } | null> {
    return await this.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [organizationId]);
      const result = await client.query<{ id: string }>(`
        update odyshell.agents set status = 'disabled', deleted_at = now(), updated_at = now()
        where organization_id = $1 and id = $2 and deleted_at is null
        returning id
      `, [organizationId, agentId]);
      const agentIds = result.rows.map((row) => row.id);
      if (agentIds.length === 0) return null;
      await client.query(`
        update odyshell.mcp_installations set status = 'revoked', updated_at = now()
        where organization_id = $1 and agent_id = any($2::text[]) and status = 'active'
      `, [organizationId, agentIds]);
      return { agentIds };
    });
  }

  async updateOrganizationAgentRole(
    organizationId: string,
    agentId: string,
    role: "standard" | "operator",
  ): Promise<AgentIdentityRecord | null> {
    const result = await this.pool.query<AgentRow>(`
      update odyshell.agents set role = $3, updated_at = now()
      where organization_id = $1 and id = $2 and status = 'active' and deleted_at is null
      returning *
    `, [organizationId, agentId, role]);
    return result.rows[0] ? agentRecord(result.rows[0]) : null;
  }

  async createEnrollmentToken(
    organizationId: string,
    tokenHash: string,
    expiresAt: number,
    createdByHumanId?: string,
  ): Promise<void> {
    await this.pool.query(`
      insert into odyshell.enrollment_tokens
        (organization_id, token_hash, created_by_human_id, expires_at)
      values ($1, $2, $3, $4)
    `, [organizationId, tokenHash, createdByHumanId ?? null, new Date(expiresAt)]);
  }

  async enrollMachine(input: {
    tokenHash: string;
    machineId: string;
    name: string;
    publicKey: string;
    previousMachineId?: string;
  }): Promise<
    | { status: "enrolled"; machineId: string; name: string;
        controlOrganizationId: string; organizationId: string; createdByHumanId?: string }
    | { status: "previous_machine_active" }
    | null
  > {
    return await this.transaction(async (client) => {
      const enrollment = await client.query<{
        organization_id: string; created_by_human_id: string | null; expires_at: Date; used_at: Date | null;
      }>(`
        select * from odyshell.enrollment_tokens where token_hash = $1 for update
      `, [input.tokenHash]);
      const token = enrollment.rows[0];
      if (!token || token.used_at || token.expires_at <= new Date()) return null;
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [token.organization_id]);
      if (input.previousMachineId) {
        const previous = await client.query(`
          select 1 from odyshell.machines
          where organization_id = $1 and id = $2 and revoked_at is null
        `, [token.organization_id, input.previousMachineId]);
        if ((previous.rowCount ?? 0) > 0) {
          return { status: "previous_machine_active" };
        }
      }
      const organization = await client.query<{ external_id: string }>(`
        select organization.external_id
        from odyshell.organizations organization
        where organization.id = $1
      `, [token.organization_id]);
      const owner = organization.rows[0];
      if (!owner) return null;
      await client.query(
        "update odyshell.enrollment_tokens set used_at = now() where token_hash = $1",
        [input.tokenHash],
      );
      await client.query(`
        insert into odyshell.machines
          (organization_id, id, name, public_key, status, created_by_human_id)
        values ($1, $2, $3, $4, 'offline', $5)
      `, [token.organization_id, input.machineId, input.name, input.publicKey, token.created_by_human_id]);
      return {
        status: "enrolled", machineId: input.machineId, name: input.name,
        controlOrganizationId: token.organization_id,
        organizationId: owner.external_id,
        ...(token.created_by_human_id ? { createdByHumanId: token.created_by_human_id } : {}),
      };
    });
  }

  async listMachines(organizationId: string): Promise<MachineRecord[]> {
    const result = await this.pool.query<MachineRow>(`
      select * from odyshell.machines where organization_id = $1 and revoked_at is null
      order by enrolled_at
    `, [organizationId]);
    return result.rows.map(machineRecord);
  }

  async updateMachineDetails(input: {
    organizationId: string;
    machineId: string;
    name: string;
    description: string;
  }): Promise<MachineRecord | null> {
    const result = await this.pool.query<MachineRow>(`
      update odyshell.machines set name = $3, description = nullif($4, '')
      where organization_id = $1 and id = $2 and revoked_at is null returning *
    `, [input.organizationId, input.machineId, input.name.trim(), input.description.trim()]);
    return result.rows[0] ? machineRecord(result.rows[0]) : null;
  }

  async activeMachinesExist(organizationId: string, machineIds: string[]): Promise<boolean> {
    if (machineIds.length === 0) return true;
    const uniqueIds = [...new Set(machineIds)];
    const result = await this.pool.query<{ count: string }>(`
      select count(*) from odyshell.machines
      where organization_id = $1 and id = any($2::text[]) and revoked_at is null
    `, [organizationId, uniqueIds]);
    return Number(result.rows[0]!.count) === uniqueIds.length;
  }

  async machinePublicKey(machineId: string): Promise<{
    publicKey: string;
    organizationId: string;
    revoked: boolean;
  } | null> {
    const result = await this.pool.query<{
      public_key: string; organization_id: string; revoked_at: Date | null;
    }>("select public_key, organization_id, revoked_at from odyshell.machines where id = $1", [machineId]);
    const row = result.rows[0];
    return row ? { publicKey: row.public_key, organizationId: row.organization_id, revoked: row.revoked_at !== null } : null;
  }

  async setMachineOffline(machineId: string): Promise<void> {
    await this.pool.query("update odyshell.machines set status = 'offline' where id = $1", [machineId]);
  }

  async setMachineOnline(machineId: string, runtime?: unknown): Promise<boolean> {
    const result = await this.pool.query(`
      update odyshell.machines set status = 'online', last_seen_at = now(),
        runtime = case when $2::jsonb is null then runtime else $2::jsonb end
      where id = $1 and revoked_at is null returning id
    `, [machineId, runtime === undefined ? null : JSON.stringify(runtime)]);
    return result.rowCount === 1;
  }

  async setMachineIncompatible(machineId: string, runtime: unknown): Promise<boolean> {
    const result = await this.pool.query(`
      update odyshell.machines set status = 'offline', last_seen_at = now(), runtime = $2::jsonb
      where id = $1 and revoked_at is null returning id
    `, [machineId, JSON.stringify(runtime)]);
    return result.rowCount === 1;
  }

  async heartbeat(machineId: string): Promise<void> {
    await this.pool.query(`
      update odyshell.machines set status = 'online', last_seen_at = now()
      where id = $1 and revoked_at is null
    `, [machineId]);
  }

  async revokeMachine(organizationId: string, machineId: string): Promise<{
    id: string;
    name: string;
    revokedAt: number;
  } | null> {
    const result = await this.pool.query<{ id: string; name: string; revoked_at: Date }>(`
      update odyshell.machines set status = 'offline', revoked_at = now()
      where organization_id = $1 and id = $2 and revoked_at is null
      returning id, name, revoked_at
    `, [organizationId, machineId]);
    const row = result.rows[0];
    return row ? { id: row.id, name: row.name, revokedAt: timestamp(row.revoked_at) } : null;
  }

  async listAudit(organizationId: string, limit: number): Promise<AuditRecord[]> {
    const result = await this.pool.query<{
      id: string; principal_id: string; action: string; target_type: string;
      target_id: string; metadata: Record<string, unknown>; created_at: Date;
    }>(`
      select * from odyshell.audit_events where organization_id = $1
      order by created_at desc limit $2
    `, [organizationId, Math.min(Math.max(limit, 1), 500)]);
    return result.rows.map((row) => ({
      id: row.id, principalId: row.principal_id, action: row.action,
      targetType: row.target_type, targetId: row.target_id,
      metadata: row.metadata, createdAt: timestamp(row.created_at),
    }));
  }

  async audit(
    organizationId: string,
    principalId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.pool.query(`
      insert into odyshell.audit_events
        (organization_id, id, principal_id, action, target_type, target_id, metadata)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `, [organizationId, randomUUID(), principalId, action, targetType, targetId, JSON.stringify(metadata)]);
  }

  async purgeExpiredData(input: { transientDataBefore: number; auditBefore: number }): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("delete from odyshell.enrollment_tokens where expires_at < $1", [
        new Date(input.transientDataBefore),
      ]);
      await client.query("delete from odyshell.audit_events where created_at < $1", [
        new Date(input.auditBefore),
      ]);
    });
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export type Database = PostgresControlDatabase;

export function createDatabase(environment: NodeJS.ProcessEnv): Database {
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new PostgresControlDatabase(connectionString);
}

export async function audit(
  database: Database,
  organizationId: string,
  principalId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await database.audit(organizationId, principalId, action, targetType, targetId, metadata);
}

async function activeInstallation(
  client: PoolClient,
  input: { organizationId: string; userId: string; oauthClientId: string; agentName: string },
): Promise<McpInstallationRecord | null> {
  const result = await client.query<{
    organization_id: string; id: string; user_id: string; oauth_client_id: string;
    agent_id: string; status: "active"; created_at: Date; updated_at: Date; agent_name: string;
    agent_role: "standard" | "operator";
  }>(`
    select installation.*, agent.name as agent_name, agent.role as agent_role
    from odyshell.mcp_installations installation
    join odyshell.agents agent
      on agent.organization_id = installation.organization_id and agent.id = installation.agent_id
    where installation.organization_id = $1 and installation.provider = 'odyshell_identity'
      and installation.user_id = $2 and installation.oauth_client_id = $3
      and installation.status = 'active' and agent.status = 'active' and agent.deleted_at is null
  `, [input.organizationId, input.userId, input.oauthClientId]);
  const row = result.rows[0];
  if (!row) return null;
  const genericName = /^(MCP Agent|MCP)$/i.test(row.agent_name);
  const agentName = genericName ? input.agentName : row.agent_name;
  if (agentName !== row.agent_name) {
    await client.query(`
      update odyshell.agents set name = $3, updated_at = now()
      where organization_id = $1 and id = $2
    `, [input.organizationId, row.agent_id, agentName]);
  }
  return installationRecord(row, agentName, row.agent_role);
}

function organizationRecord(row: OrganizationRow): OrganizationRecord {
  return {
    id: row.id, slug: row.slug, name: row.name, externalId: row.external_id,
    avatarSeed: row.avatar_seed, loggingLevel: row.logging_level,
    createdAt: timestamp(row.created_at),
  };
}

function mcpOrganizationRecord(row: {
  organization_id: string; organization_name: string; organization_external_id: string;
}): McpOrganizationRecord {
  return {
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationExternalId: row.organization_external_id,
  };
}

function agentRecord(row: AgentRow): AgentIdentityRecord {
  return {
    organizationId: row.organization_id, id: row.id, name: row.name, role: row.role,
    ...(row.created_by_human_id ? { createdByHumanId: row.created_by_human_id } : {}),
    status: row.status,
    ...(row.deleted_at ? { deletedAt: timestamp(row.deleted_at) } : {}),
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}

function installationRecord(row: {
  organization_id: string; id: string; user_id: string; oauth_client_id: string;
  agent_id: string; status: "active" | "revoked"; created_at: Date; updated_at: Date;
}, agentName: string, agentRole: "standard" | "operator" = "standard"): McpInstallationRecord {
  return {
    organizationId: row.organization_id, id: row.id, userId: row.user_id,
    oauthClientId: row.oauth_client_id, agentId: row.agent_id, agentName, agentRole,
    status: row.status, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}

function machineRecord(row: MachineRow): MachineRecord {
  return {
    id: row.id, name: row.name, ...(row.description ? { description: row.description } : {}),
    publicKey: row.public_key, status: row.status,
    ...(row.runtime === null ? {} : { runtime: row.runtime }),
    ...(row.last_seen_at ? { lastSeenAt: timestamp(row.last_seen_at) } : {}),
    enrolledAt: timestamp(row.enrolled_at),
    ...(row.revoked_at ? { revokedAt: timestamp(row.revoked_at) } : {}),
  };
}

function timestamp(value: Date): number {
  return value.getTime();
}

const controlSchemaSql = `
  create schema if not exists odyshell;

  create table if not exists odyshell.organizations (
    id text primary key,
    slug text not null,
    name text not null,
    external_id text not null unique,
    avatar_seed text not null default 'default',
    logging_level text not null default 'privacy-minimal'
      check (logging_level in ('privacy-minimal', 'operational', 'diagnostic')),
    created_at timestamptz not null default now()
  );

  create table if not exists odyshell.user_preferences (
    external_id text primary key,
    time_zone text not null default 'System',
    updated_at timestamptz not null default now()
  );

  create table if not exists odyshell.notifications (
    organization_id text not null references odyshell.organizations(id) on delete cascade,
    id text primary key,
    user_id text not null,
    kind text not null,
    title text not null,
    description text not null default '',
    href text not null,
    resource_id text not null,
    read_at timestamptz,
    created_at timestamptz not null default now()
  );
  create index if not exists notifications_recipient_idx
    on odyshell.notifications (organization_id, user_id, created_at desc);

  create table if not exists odyshell.machines (
    organization_id text not null references odyshell.organizations(id) on delete cascade,
    id text primary key,
    name text not null,
    description text,
    public_key text not null,
    status text not null default 'offline',
    runtime jsonb,
    last_seen_at timestamptz,
    revoked_at timestamptz,
    created_by_human_id text,
    enrolled_at timestamptz not null default now()
  );
  create index if not exists machines_organization_idx
    on odyshell.machines (organization_id, enrolled_at);

  create table if not exists odyshell.enrollment_tokens (
    organization_id text not null references odyshell.organizations(id) on delete cascade,
    token_hash text primary key,
    created_by_human_id text,
    expires_at timestamptz not null,
    used_at timestamptz,
    created_at timestamptz not null default now()
  );

  create table if not exists odyshell.agents (
    organization_id text not null references odyshell.organizations(id) on delete cascade,
    id text not null,
    name text not null,
    role text not null default 'standard' check (role in ('standard', 'operator')),
    created_by_human_id text,
    status text not null check (status in ('active', 'disabled')),
    deleted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (organization_id, id)
  );
  alter table odyshell.agents add column if not exists role text not null default 'standard';
  alter table odyshell.agents drop constraint if exists agents_role_check;
  alter table odyshell.agents add constraint agents_role_check
    check (role in ('standard', 'operator'));
  alter table odyshell.agents drop column if exists parent_agent_id cascade;
  alter table odyshell.agents drop column if exists kind;

  create table if not exists odyshell.mcp_installations (
    organization_id text not null references odyshell.organizations(id) on delete cascade,
    id text not null,
    provider text not null,
    user_id text not null,
    oauth_client_id text not null,
    agent_id text not null,
    status text not null check (status in ('active', 'revoked')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (organization_id, id),
    unique (organization_id, provider, user_id, oauth_client_id),
    foreign key (organization_id, agent_id) references odyshell.agents(organization_id, id)
  );

  create table if not exists odyshell.audit_events (
    organization_id text not null references odyshell.organizations(id) on delete cascade,
    id text primary key,
    principal_id text not null,
    action text not null,
    target_type text not null,
    target_id text not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
  create index if not exists audit_organization_created_idx
    on odyshell.audit_events (organization_id, created_at desc);
`;
