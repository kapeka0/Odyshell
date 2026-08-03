import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createDatabase,
  withDatabaseDeadlockRetry,
} from "../apps/server/src/database.js";

describe("server storage boundaries", () => {
  it("retries transient PostgreSQL deadlocks without hiding other failures", async () => {
    let attempts = 0;
    await expect(
      withDatabaseDeadlockRetry(async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("deadlock"), { code: "40P01" });
        }
        return "completed";
      }),
    ).resolves.toBe("completed");
    expect(attempts).toBe(3);

    const rejected = Object.assign(new Error("authorization failed"), {
      code: "42501",
    });
    await expect(
      withDatabaseDeadlockRetry(async () => {
        throw rejected;
      }),
    ).rejects.toBe(rejected);
  });

  it("serializes Client acknowledgements with Session cancellation", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const cancellation = database.slice(
      database.indexOf("async cancelAgentSession("),
      database.indexOf("async failClaimedAgentSession("),
    );
    const acknowledgements = database.slice(
      database.indexOf("async markSessionOpened("),
      database.indexOf("async findOperationByIdempotency("),
    );

    expect(cancellation.indexOf('.updateTable("sessions")')).toBeLessThan(
      cancellation.indexOf('.updateTable("agentSessionTargets")'),
    );
    expect(acknowledgements.match(/withDatabaseDeadlockRetry/g)).toHaveLength(
      3,
    );
  });

  it("requires PostgreSQL in every environment", () => {
    expect(() => createDatabase({ NODE_ENV: "production" })).toThrow(/DATABASE_URL/);
    expect(() =>
      createDatabase({
        NODE_ENV: "test",
        ODYSHELL_STORAGE: "memory",
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it("serializes agent deletion with session creation and scopes both by workspace", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const deletion = database.slice(
      database.indexOf("async deleteAgentToken("),
      database.indexOf("async expireAgentSessions("),
    );
    const creation = database.slice(
      database.indexOf("async createSession("),
      database.indexOf("async getSession("),
    );

    expect(deletion).toContain("this.db.transaction()");
    expect(deletion).toContain('.where("workspaceId", "=", workspaceId)');
    expect(deletion).toContain('.where("deletedAt", "is", null)');
    expect(deletion.indexOf('.updateTable("agentTokens")')).toBeLessThan(
      deletion.indexOf('.updateTable("sessions")'),
    );
    expect(creation).toContain("this.db.transaction()");
    expect(creation).toContain('.where("workspaceId", "=", input.workspaceId)');
    expect(creation).toContain('.where("revokedAt", "is", null)');
    expect(creation).toContain('.where("deletedAt", "is", null)');
    expect(creation).toContain(".forShare()");
  });

  it("deletes persistent Agent hierarchies without erasing their audit identity", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const deletion = database.slice(
      database.indexOf("async deleteWorkspaceAgent("),
      database.indexOf("async proposeAgentPolicy("),
    );

    expect(deletion).toContain("this.db.transaction()");
    expect(deletion).toContain('.where("workspaceId", "=", workspaceId)');
    expect(deletion).toContain('.where("parentAgentId", "=", agentId)');
    expect(deletion).toContain('.updateTable("agentCredentials")');
    expect(deletion).toContain('.updateTable("agentPolicies")');
    expect(deletion).toContain('.updateTable("mcpSessionGrants")');
    expect(deletion).toContain('.updateTable("mcpInstallations")');
    expect(deletion).toContain('deletedAt: now');
    expect(deletion).not.toContain('.deleteFrom("agents")');
    expect(deletion.indexOf('.updateTable("agentCredentials")')).toBeLessThan(
      deletion.indexOf('.updateTable("agents")'),
    );
    expect(deletion.indexOf('.updateTable("mcpInstallations")')).toBeLessThan(
      deletion.indexOf('.updateTable("agents")'),
    );
  });

  it("stores privacy-minimal notifications for one responsible workspace member", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const migration = database.slice(
      database.indexOf("async function migrateNotifications("),
      database.indexOf("const migrationProvider"),
    );
    const listing = database.slice(
      database.indexOf("async listNotifications("),
      database.indexOf("async listWorkspaces("),
    );
    const sessionRequest = database.slice(
      database.indexOf("async createAgentSessionRequest("),
      database.indexOf("async sessionRequestForApproval("),
    );

    expect(migration).toContain("create table odyshell.notifications");
    expect(migration).toContain("created_by_human_id");
    expect(migration).not.toContain("stdout");
    expect(migration).not.toContain("stderr");
    expect(listing).toContain('.where("workspaceId", "=", workspaceId)');
    expect(listing).toContain('.where("userId", "=", userId)');
    expect(listing).toContain("async markAllNotificationsRead(");
    expect(sessionRequest).toContain('.insertInto("notifications")');
    expect(sessionRequest).toContain("userId: input.humanId");
  });

  it("expands identity and authority without making legacy sessions canonical", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const migration = database.slice(
      database.indexOf("async function migrateIdentityAuthorityExpand("),
      database.indexOf("const migrationProvider"),
    );
    const agentTable = migration.slice(
      migration.indexOf("create table if not exists odyshell.agents"),
      migration.indexOf("create table if not exists odyshell.agent_credentials"),
    );
    const agentCredentialTable = migration.slice(
      migration.indexOf(
        "create table if not exists odyshell.agent_credentials",
      ),
      migration.indexOf("create table if not exists odyshell.agent_sessions"),
    );
    const agentSessionTable = migration.slice(
      migration.indexOf("create table if not exists odyshell.agent_sessions"),
      migration.indexOf(
        "create table if not exists odyshell.session_credentials",
      ),
    );
    const sessionCredentialTable = migration.slice(
      migration.indexOf(
        "create table if not exists odyshell.session_credentials",
      ),
      migration.indexOf("create index if not exists humans_workspace_created_idx"),
    );
    const legacyCreation = database.slice(
      database.indexOf("async createSession("),
      database.indexOf("async getSession("),
    );

    expect(migration).not.toContain("rename to legacy_sessions");
    expect(migration).toContain(
      "create table if not exists odyshell.humans",
    );
    expect(migration).toContain(
      "create table if not exists odyshell.agents",
    );
    expect(migration).toContain(
      "create table if not exists odyshell.agent_credentials",
    );
    expect(migration).toContain(
      "create table if not exists odyshell.agent_sessions",
    );
    expect(migration).toContain(
      "create table if not exists odyshell.session_credentials",
    );
    expect(agentTable).not.toContain("machine_ids");
    expect(agentTable).not.toContain("capabilities");
    expect(agentTable).toContain("unique (workspace_id, id, kind)");
    expect(agentCredentialTable).toContain(
      "agent_kind text not null default 'independent'",
    );
    expect(agentCredentialTable).toContain(
      "foreign key (workspace_id, agent_id, agent_kind)",
    );
    expect(agentCredentialTable).toContain(
      "expires_at <= created_at + interval '1 year'",
    );
    expect(agentCredentialTable).toContain(
      "unique (workspace_id, token_hash)",
    );
    expect(agentCredentialTable).not.toContain(
      "token_hash text not null unique",
    );
    expect(agentSessionTable).toContain(
      "unique (workspace_id, id, expires_at)",
    );
    expect(sessionCredentialTable).toContain(
      "foreign key (workspace_id, session_id, expires_at)",
    );
    expect(sessionCredentialTable).toContain(
      "unique (workspace_id, token_hash)",
    );
    expect(sessionCredentialTable).not.toContain(
      "token_hash text not null unique",
    );
    expect(sessionCredentialTable).not.toContain("token text");
    expect(migration).toContain(
      "foreign key (workspace_id, agent_id)",
    );
    expect(migration).toContain(
      "expires_at <= created_at + interval '24 hours'",
    );
    expect(migration).toContain(
      "Identity authority expansion requires the legacy session table",
    );
    expect(migration).toContain(
      "Cannot roll back identity authority expansion after target data exists",
    );
    expect(migration).toContain("drop table odyshell.agent_sessions");
    expect(legacyCreation).toContain('.insertInto("sessions")');
    expect(legacyCreation).not.toContain('.insertInto("agentSessions")');
  });

  it("stores approval and Session authority with workspace and replay boundaries", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const migration = database.slice(
      database.indexOf("async function migrateApprovedReadSessions("),
      database.indexOf("const migrationProvider"),
    );
    const requestCreation = database.slice(
      database.indexOf("async createAgentSessionRequest("),
      database.indexOf("async sessionRequestForApproval("),
    );
    const approval = database.slice(
      database.indexOf("async approveAgentSessionRequest("),
      database.indexOf("async claimAgentSessionRequest("),
    );
    const claim = database.slice(
      database.indexOf("async claimAgentSessionRequest("),
      database.indexOf("async findSessionCredentialPrincipal("),
    );

    expect(migration).toContain(
      "unique (workspace_id, approval_code_hash)",
    );
    expect(migration).toContain(
      "session_credentials_token_hash_global_idx",
    );
    expect(migration).toContain(
      "operations_session_principal_idempotency_unique",
    );
    expect(migration).toContain(
      "check (capabilities = '[\"fs.read\"]'::jsonb)",
    );
    expect(requestCreation).toContain('.where("workspaceId", "=", input.workspaceId)');
    expect(requestCreation).toContain('.where("createdByHumanId", "=", input.humanId)');
    expect(approval).toContain(".forUpdate()");
    expect(approval).toContain('.where("workspaceId", "=", input.workspaceId)');
    expect(approval).toContain("SESSION_CLAIM_WINDOW_MILLISECONDS");
    expect(claim).toContain(".forUpdate()");
    expect(claim).toContain(
      "request.requestedByHumanId !== input.humanId",
    );
    expect(claim).toContain('.insertInto("sessionCredentials")');
    expect(claim).not.toContain("sessionToken");

    const idempotencyLookup = database.slice(
      database.indexOf("async findOperationByIdempotency("),
      database.indexOf("async sessionForOperation("),
    );
    expect(idempotencyLookup).toContain('.where("sessionId", "=", sessionId)');
  });

  it("creates canonical Sessions only for an active Agent in the same workspace", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const creation = database.slice(
      database.indexOf("async createAgentSession("),
      database.indexOf("async getActiveAgentSession("),
    );

    expect(creation).toContain("this.db.transaction()");
    expect(creation).toContain('.selectFrom("agents")');
    expect(creation).toContain(
      '.where("workspaceId", "=", input.workspaceId)',
    );
    expect(creation).toContain('.where("id", "=", input.agentId)');
    expect(creation).toContain('.where("status", "=", "active")');
    expect(creation).toContain(".forShare()");
    expect(creation).toContain('.insertInto("agentSessions")');
    expect(creation).not.toContain("agentTokens");
    expect(creation).not.toContain('.insertInto("sessions")');
  });

  it("returns canonical Session metadata only while its Agent and Session are active", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const lookup = database.slice(
      database.indexOf("async getActiveAgentSession("),
      database.indexOf("async findAgentByTokenHash("),
    );

    expect(lookup).toContain('.innerJoin("agents"');
    expect(lookup).toContain('.where("agentSessions.status", "=", "active")');
    expect(lookup).toContain('.where("agentSessions.createdAt", "<=", now)');
    expect(lookup).toContain('.where("agentSessions.expiresAt", ">", now)');
    expect(lookup).toContain('.where("agents.status", "=", "active")');
  });

  it("scopes workspace Session observability and cancellation to the requester", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const listing = database.slice(
      database.indexOf("async listWorkspaceAgentSessions("),
      database.indexOf("async createAgentSessionRequest("),
    );
    const cancellation = database.slice(
      database.indexOf("async cancelAgentSession("),
      database.indexOf("async rejectAgentSessionTarget("),
    );

    expect(listing).toContain(
      '.where("agentSessions.workspaceId", "=", workspaceId)',
    );
    expect(listing).toContain(
      '"agentSessionRequests.requestedByHumanId"',
    );
    expect(listing).toContain(
      '"agentSessionRequests.requestedByAgentId"',
    );
    expect(listing).toContain(
      'expression("agentSessions.agentId", "=", requester.agentId!)',
    );
    expect(listing).toContain(
      '.where("agentSessionTargets.workspaceId", "=", workspaceId)',
    );
    expect(cancellation).toContain(
      "request?.requestedByHumanId !== input.requestedByHumanId",
    );
    expect(cancellation.indexOf('.updateTable("sessionCredentials")')).toBeLessThan(
      cancellation.indexOf('.updateTable("agentSessions")'),
    );
  });

  it("lists unclaimed Session requests only inside their Workspace", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const listing = database.slice(
      database.indexOf("async listWorkspaceAgentSessionRequests("),
      database.indexOf("async workspaceAgentSession("),
    );

    expect(listing).toContain(
      '.where("agentSessionRequests.workspaceId", "=", workspaceId)',
    );
    expect(listing).toContain(
      '.where("agentSessionRequests.status", "!=", "claimed")',
    );
    expect(listing).toContain('.where("status", "in", ["pending", "approved"])');
    expect(listing).toContain('.set({ status: "expired", updatedAt: now })');
  });

  it("recovers MCP requests only for their Workspace, Agent and human owner", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const listing = database.slice(
      database.indexOf("async listAgentSessionRequests("),
      database.indexOf("async workspaceAgentSession("),
    );

    expect(listing).toContain('.where("workspaceId", "=", workspaceId)');
    expect(listing).toContain('.where("agentId", "=", agentId)');
    expect(listing).toContain(
      '.where("requestedByHumanId", "=", humanId)',
    );
    expect(listing).toContain('.limit(Math.min(Math.max(limit, 1), 100))');
  });

  it("stores headless Agent authorization codes and credentials as hashes", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const migration = database.slice(
      database.indexOf("async function migrateAgentDeviceAuthorization("),
      database.indexOf("const migrationProvider"),
    );
    const exchange = database.slice(
      database.indexOf("async exchangeAgentDeviceAuthorization("),
      database.indexOf("async findAgentCredentialByTokenHash("),
    );
    const rotation = database.slice(
      database.indexOf("async rotateAgentCredential("),
      database.indexOf("async createEnrollmentToken("),
    );

    expect(migration).toContain("agent_device_authorizations");
    expect(migration).toContain("device_code_hash text not null unique");
    expect(migration).toContain("user_code_hash text not null unique");
    expect(migration).not.toContain("device_code text");
    expect(exchange).toContain('.insertInto("agentCredentials")');
    expect(exchange).not.toContain("accessToken");
    expect(rotation).toContain(".forUpdate()");
    expect(rotation).toContain('status: "retiring"');
    expect(rotation).toContain('current.status !== "active"');
    expect(rotation).not.toContain('["active", "retiring"]');
    expect(rotation).toContain("10 * 60 * 1_000");
  });

  it("versions autoapproval ceilings and permanently binds approved Sessions to them", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const migration = database.slice(
      database.indexOf("async function migrateAgentAutoapprovalPolicies("),
      database.indexOf("const migrationProvider"),
    );
    const proposal = database.slice(
      database.indexOf("async proposeAgentPolicy("),
      database.indexOf("async listAgentPolicies("),
    );
    const approval = database.slice(
      database.indexOf("async approveAgentPolicy("),
      database.indexOf("async transitionAgentPolicy("),
    );
    const request = database.slice(
      database.indexOf("async createAgentSessionRequest("),
      database.indexOf("async sessionRequestForApproval("),
    );
    const claim = database.slice(
      database.indexOf("async claimAgentSessionRequest("),
      database.indexOf("async findAgentSessionCredentialByTokenHash("),
    );

    expect(migration).toContain("agent_policies_one_active_idx");
    expect(migration).toContain("where status = 'active'");
    expect(migration).toContain("autoapproval_policy_version");
    expect(proposal).toContain(".forUpdate()");
    expect(approval).toContain(".forUpdate()");
    expect(approval).toContain('.where("version", ">", policy.version)');
    expect(request).toContain("autoapprovalDecision");
    expect(request).toContain('eventType: "session.autoapproved"');
    expect(claim).toContain(
      "autoapprovalPolicyId: request.autoapprovalPolicyId",
    );
    expect(claim).toContain(
      "autoapprovalPolicyVersion: request.autoapprovalPolicyVersion",
    );
  });

  it("makes Session denial terminal and records it outside agent control", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const denial = database.slice(
      database.indexOf("async denyAgentSessionRequest("),
      database.indexOf("async claimAgentSessionRequest("),
    );
    const claim = database.slice(
      database.indexOf("async claimAgentSessionRequest("),
      database.indexOf("async findAgentSessionCredentialByTokenHash("),
    );

    expect(denial).toContain('.where("approvalCodeHash", "="');
    expect(denial).toContain(".forUpdate()");
    expect(denial).toContain('request.status !== "pending"');
    expect(denial).toContain('status: "denied"');
    expect(denial).toContain('eventType: "session.denied"');
    expect(denial).toContain('source: "verified"');
    expect(claim).toContain(
      'if (request.status === "denied") return { status: "denied" }',
    );
  });

  it("binds one-level Managed Agents to a live parent Delegation Policy", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const migration = database.slice(
      database.indexOf("async function migrateManagedAgentDelegation("),
      database.indexOf("const migrationProvider"),
    );
    const creation = database.slice(
      database.indexOf("async createManagedAgent("),
      database.indexOf("async listManagedAgents("),
    );
    const request = database.slice(
      database.indexOf("async createAgentSessionRequest("),
      database.indexOf("async sessionRequestForApproval("),
    );
    const cascade = database.slice(
      database.indexOf("async revokeAgentHierarchyByTokenHash("),
      database.indexOf("async createEnrollmentToken("),
    );

    expect(migration).toContain("agent_policies_delegation_fk");
    expect(migration).toContain("agent_policies_one_active_kind_idx");
    expect(migration).toContain(
      "Cannot roll back Managed Agent delegation while derived records exist",
    );
    expect(creation).toContain('.where("kind", "=", "independent")');
    expect(creation).toContain("managedDelegationDecision({");
    expect(request).toContain("delegationPolicyVersion");
    expect(request).toContain("managedDelegationDecision({");
    expect(cascade).toContain('.where("parentAgentId", "=", credential.agentId)');
    expect(cascade).toContain('.updateTable("agentCredentials")');
    expect(cascade).toContain('.updateTable("agentPolicies")');
  });

  it("stores Event Sink secrets encrypted and keeps retry state workspace-scoped", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const migration = database.slice(
      database.indexOf("async function migrateTimelineEventSinks("),
      database.indexOf("const migrationProvider"),
    );
    const pending = database.slice(
      database.indexOf("async pendingEventSinkDeliveries("),
      database.indexOf("async completeEventSinkDelivery("),
    );
    const diagnostics = database.slice(
      database.indexOf("async operationTimelineMetadata("),
      database.indexOf("async workspaceEventSink("),
    );
    const start = database.slice(
      database.indexOf("async markOperationStarted("),
      database.indexOf("async addOperationEvent("),
    );
    const completion = database.slice(
      database.indexOf("async markOperationCompleted("),
      database.indexOf("async getOperation("),
    );

    expect(migration).toContain("secret_ciphertext text not null");
    expect(migration).not.toContain("signing_secret text");
    expect(migration).toContain(
      "unique (workspace_id, sink_id, event_id)",
    );
    expect(diagnostics).toContain('.where("workspaceId", "=", workspaceId)');
    expect(diagnostics).toContain("operationTimelineMetadata(operation.action)");
    expect(diagnostics).toContain("diagnosticTimelineMetadata(operationEvents)");
    expect(start).not.toContain("operationTimelineMetadata(operation.action)");
    expect(completion).not.toContain("diagnosticTimelineMetadata");
    expect(migration).toContain(
      "foreign key (workspace_id, event_id)",
    );
    expect(migration).toContain(
      "rollbackTimelineEventSinks",
    );
    expect(pending).toContain(
      '.where("delivery.status", "in", ["pending", "retrying"])',
    );
    expect(pending).toContain(
      '.where("delivery.nextAttemptAt", "<=", new Date(now))',
    );
  });
});
