import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalSessionTargetDecision,
  createDatabase,
  defaultCloudWorkspaceName,
  withDatabaseDeadlockRetry,
} from "../apps/server/src/database.js";

describe("server storage boundaries", () => {
  it("names a new Cloud Workspace after its member", () => {
    expect(defaultCloudWorkspaceName("Karim Ahmed")).toBe("Karim's Workspace");
    expect(defaultCloudWorkspaceName("James")).toBe("James' Workspace");
    expect(defaultCloudWorkspaceName()).toBe("Default workspace");
    expect(defaultCloudWorkspaceName("a".repeat(128))).toHaveLength(96);
  });

  it("checks machine scope before persisting Session approval state", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const request = database.slice(
      database.indexOf("async createAgentSessionRequest("),
      database.indexOf("async sessionRequestForApproval("),
    );

    expect(request.indexOf("!machineScopesAllowed(machines, scopes)")).toBeGreaterThan(-1);
    expect(request.indexOf("!machineScopesAllowed(machines, scopes)")).toBeLessThan(
      request.indexOf('.insertInto("agentSessionRequests")'),
    );
  });

  it("snapshots workspace logging policy into every Session", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const migration = database.slice(
      database.indexOf("async function migrateWorkspaceSettings("),
      database.indexOf("const migrationProvider"),
    );
    const request = database.slice(
      database.indexOf("async createAgentSessionRequest("),
      database.indexOf("async sessionRequestForApproval("),
    );
    const claim = database.slice(
      database.indexOf("async claimAgentSessionRequest("),
      database.indexOf("async findAgentSessionCredentialByTokenHash("),
    );

    expect(migration).toContain("logging_level text not null default 'privacy-minimal'");
    expect(migration).toContain("create table odyshell.user_preferences");
    expect(request).toContain('.select("loggingLevel")');
    expect(request).toContain("loggingLevel: workspace.loggingLevel");
    expect(claim).toContain("loggingLevel: request.loggingLevel");
  });

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
      database.indexOf("async replayOperationByIdempotency("),
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
    expect(database).toContain("async notifyStaleOfflineMachines(");
    expect(database).toContain('kind: "machine.offline"');
    expect(database).toContain('selectFrom("humans")');
    expect(database).toContain("const activeOwner = machine.createdByHumanId");
    expect(database).toContain("const recipientId = activeOwner?.id ??");
  });

  it("fails Session openings after a bounded acknowledgement window", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const timeout = database.slice(
      database.indexOf("async failStaleSessionOpenings("),
      database.indexOf("async expireSessions("),
    );

    expect(timeout).toContain('status: "failed"');
    expect(timeout).toContain('error: "session_open_timeout"');
    expect(timeout).toContain('eventType: "target.rejected"');
    expect(timeout).toContain("reconcileCanonicalAgentSession");
    expect(timeout).toContain('.where("status", "=", "opening")');
    expect(canonicalSessionTargetDecision(["rejected"])).toBe("failed");
    expect(canonicalSessionTargetDecision(["ready", "rejected"])).toBe("ready");
  });

  it("makes a Session usable when its first target becomes ready", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const reconciliation = database.slice(
      database.indexOf("async function reconcileCanonicalAgentSession("),
      database.indexOf("type AgentSessionTerminationInput"),
    );

    expect(canonicalSessionTargetDecision(["ready", "opening"])).toBe("ready");
    expect(canonicalSessionTargetDecision(["ready", "ready"])).toBe("ready");
    expect(reconciliation).toContain('.where("readyAt", "is", null)');
    expect(reconciliation).toContain('kind: "session.ready"');
    expect(reconciliation).toContain('.updateTable("sessionCredentials")');
  });

  it("preserves authority on disconnect and reopens active targets after reconnect", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const disconnect = database.slice(
      database.indexOf("async markMachineDisconnected("),
      database.indexOf("async setMachineOnline("),
    );
    const reconnect = database.slice(
      database.indexOf("async reconnectAgentSessionTargets("),
      database.indexOf("async setMachineIncompatible("),
    );
    const pendingClose = database.slice(
      database.indexOf("async agentSessionTargetsPendingClose("),
      database.indexOf("async setMachineIncompatible("),
    );
    const reconciliation = database.slice(
      database.indexOf("async function reconcileCanonicalAgentSession("),
      database.indexOf("type AgentSessionTerminationInput"),
    );

    expect(disconnect).not.toContain('.updateTable("operations")');
    expect(disconnect).not.toContain('.updateTable("sessions")');
    expect(disconnect).not.toContain('.updateTable("agentSessionTargets")');
    expect(reconnect).toContain('"agentSessionTargets.status"');
    expect(reconnect).toContain('["opening", "ready", "rejected"]');
    expect(reconnect).toContain('.where("agentSessions.status", "=", "active")');
    expect(reconnect).toContain('.where("agentSessions.expiresAt", ">", now)');
    expect(reconnect).toContain('status: "opening"');
    expect(reconnect).toContain('eventType: "target.reconnecting"');
    expect(pendingClose).toContain('.where("sessions.status", "=", "closing")');
    expect(pendingClose).toContain('reason: target.canonicalStatus');
    expect(reconciliation).not.toContain('kind: "session.failed"');
    expect(reconciliation).not.toContain('.updateTable("mcpSessionGrants")');
  });

  it("revokes machine targets canonically and revalidates Operation delivery", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const revocation = database.slice(
      database.indexOf("async revokeMachine("),
      database.indexOf("async listSessions("),
    );
    const operationCreation = database.slice(
      database.indexOf("async createOperation("),
      database.indexOf("async markOperationStarted("),
    );

    expect(revocation).toContain('.updateTable("agentSessionTargets")');
    expect(revocation).toContain('.updateTable("agentSessions")');
    expect(revocation).toContain('.updateTable("sessionCredentials")');
    expect(revocation).toContain('.updateTable("mcpSessionGrants")');
    expect(revocation).toContain('eventType: "target.revoked"');
    expect(revocation).toContain('eventType: "operation.completed"');
    expect(revocation).toContain('status: "execution_unknown"');
    expect(revocation).toContain('error: "machine_revoked"');
    expect(revocation).toContain("kind: operation.action.kind");
    expect(revocation).not.toContain("command:");
    expect(revocation).toContain(
      '.returning(["id", "sessionId", "action"])',
    );
    expect(revocation).toContain("withDatabaseDeadlockRetry");
    expect(revocation).toContain('.orderBy("sessionId")');
    expect(revocation).toContain('.orderBy("machineId")');
    expect(operationCreation).toContain('.innerJoin("machines"');
    expect(operationCreation).toContain('.where("sessions.status", "=", "ready")');
    expect(operationCreation).toContain('.where("machines.revokedAt", "is", null)');
    expect(operationCreation).toContain('.where("sessions.expiresAt", ">", now)');
    expect(operationCreation).toContain("const authorizedAt = new Date()");
    expect(operationCreation).toContain("runtime.expiresAt <= authorizedAt");
    expect(operationCreation).toContain("canonical.targetMachineId !== input.machineId");
    expect(operationCreation).toContain(".forShare()");
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
    expect(claim).toContain("request.agentId !== input.agentId");
    expect(claim).toContain("hostShellTaskRunAccessDecision(");
    expect(claim).toContain("input.runId");
    expect(claim.indexOf("hostShellTaskRunAccessDecision(")).toBeLessThan(
      claim.indexOf('.insertInto("sessionCredentials")'),
    );
    expect(claim).toContain('.where("id", "=", input.authority.installationId)');
    expect(claim).toContain('.where("userId", "=", input.humanId)');
    expect(claim).toContain('.insertInto("sessionCredentials")');
    expect(claim).not.toContain("sessionToken");

    const idempotencyReplay = database.slice(
      database.indexOf("async replayOperationByIdempotency("),
      database.indexOf("async sessionForOperation("),
    );
    const operationCreation = database.slice(
      database.indexOf("async createOperation("),
      database.indexOf("async markOperationStarted("),
    );
    expect(idempotencyReplay).toContain(
      '.where("idempotencyScopeId", "=", input.idempotencyScopeId)',
    );
    expect(idempotencyReplay).toContain('"idempotencyFingerprint"');
    expect(idempotencyReplay).toContain(".forUpdate()");
    expect(idempotencyReplay.indexOf("dispatch(operation)")).toBeLessThan(
      idempotencyReplay.indexOf('.updateTable("operations")'),
    );
    expect(migration).toContain("operations_scope_principal_idempotency_unique");
    expect(migration).toContain(
      "partition by workspace_id, idempotency_scope_id, principal_id, idempotency_key",
    );
    expect(migration).toContain(
      "unique (workspace_id, idempotency_scope_id, principal_id, idempotency_key)",
    );
    expect(migration).toContain("idempotency_fingerprint");
    expect(operationCreation).toContain(
      "canonical.canonicalSessionId !== input.idempotencyScopeId",
    );
    expect(operationCreation).toContain(
      '.insertInto("operationIdempotencyKeys")',
    );
    expect(operationCreation).toMatch(
      /\.columns\(\[\s*"workspaceId",\s*"idempotencyScopeId",\s*"principalId",\s*"idempotencyKeyHash",?\s*\]\)/u,
    );
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

  it("uses one payload-free idempotency registry before and after Operation purge", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const migration = database.slice(
      database.indexOf("async function migrateOperationIdempotencyKeys("),
      database.indexOf("const migrationProvider"),
    );
    const replay = database.slice(
      database.indexOf("async replayOperationByIdempotency("),
      database.indexOf("async sessionForOperation("),
    );
    const completion = database.slice(
      database.indexOf("async markOperationCompleted("),
      database.indexOf("async getOperation("),
    );
    const purge = database.slice(
      database.indexOf("async purgeExpiredData("),
      database.indexOf("async notifyStaleOfflineMachines("),
    );

    expect(migration).toContain("create table odyshell.operation_idempotency_keys");
    expect(migration).toContain(
      "unique (workspace_id, idempotency_scope_id, principal_id, idempotency_key_hash)",
    );
    expect(migration).toContain("set has_transient_input = (action ->> 'kind' = 'host.shell')");
    expect(migration).toContain("drop column idempotency_key");
    expect(migration).not.toContain("action jsonb");
    expect(migration).not.toContain("command");
    expect(replay).toContain('selectFrom("operationIdempotencyKeys")');
    expect(replay).toContain("operationIdempotencyKeyHash(input.idempotencyKey)");
    expect(replay).toContain('"hasTransientInput"');
    expect(replay).toContain("operation.id !== input.freshOperationId");
    expect(completion).toContain('selectFrom("operationIdempotencyKeys")');
    expect(completion).toContain('.where("machineId", "=", input.machineId)');
    expect(purge.indexOf('.updateTable("operationIdempotencyKeys")')).toBeLessThan(
      purge.indexOf('.deleteFrom("operations")'),
    );
    expect(purge).toContain('.where("purgedAt", "<", auditBefore)');
  });

  it("terminalizes Operations by an absolute execution deadline", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );
    const expiry = database.slice(
      database.indexOf("async expireStaleOperations("),
      database.indexOf("async getOperation("),
    );
    const expiryTimer = server.slice(
      server.indexOf("const expiryTimer = setInterval("),
      server.indexOf("const retentionTimer = setInterval("),
    );

    expect(expiry).toContain('sql.ref("operations.createdAt")');
    expect(expiry).toContain('sql.ref("operations.timeoutSeconds")');
    expect(expiry).not.toContain('sql.ref("operations.updatedAt")');
    expect(expiry).toContain('.forUpdate("operations")');
    expect(expiry).toContain('error: "completion_not_received"');
    expect(expiry).toContain('status: "execution_unknown"');
    expect(expiry).toContain('eventType: "operation.completed"');
    expect(expiry.match(/\.insertInto\("sessionTimelineEvents"\)/gu)).toHaveLength(1);
    expect(expiryTimer).toContain("await db.expireStaleOperations()");
    expect(expiryTimer).toContain("if (sweepingExpiry) return");
    expect(expiryTimer).toContain("sweepingExpiry = false");
    expect(expiryTimer).toContain('type: "operation.cancel"');
    expect(expiryTimer).toContain('error: "completion_not_received"');
  });

  it("persists cancellation before transport and retries its signal idempotently", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );
    const cancellation = database.slice(
      database.indexOf("async requestOperationCancellation("),
      database.indexOf("async operationExists("),
    );
    const completion = database.slice(
      database.indexOf("async markOperationCompleted("),
      database.indexOf("async expireStaleOperations("),
    );
    const expiry = database.slice(
      database.indexOf("async expireStaleOperations("),
      database.indexOf("async getOperation("),
    );
    const endpoint = server.slice(
      server.indexOf('"/v1/operations/:operationId/cancel"'),
      server.indexOf('"/v1/operations/:operationId/events"'),
    );
    const reconnect = database.slice(
      database.indexOf("async pendingOperationCancellations("),
      database.indexOf("async operationExists("),
    );

    expect(cancellation.indexOf('.forUpdate("operations")')).toBeLessThan(
      cancellation.indexOf('status: "cancellation_requested"'),
    );
    expect(cancellation).toContain('error: "cancellation_requested"');
    expect(cancellation).toContain('.insertInto("auditEvents")');
    expect(cancellation).toContain('action: "operation.cancel_requested"');
    expect(endpoint.indexOf("await db.requestOperationCancellation(")).toBeLessThan(
      endpoint.indexOf('type: "operation.cancel"'),
    );
    expect(endpoint).toContain(
      'operation.status !== "cancellation_requested"',
    );
    expect(endpoint).toContain("await gateway.runMachineLifecycle(");
    expect(endpoint).not.toContain('"operation.cancel_requested"');
    expect(reconnect).toContain('.where("operations.status", "=", "cancellation_requested")');
    expect(completion).toContain(
      '.where("status", "in", NONTERMINAL_OPERATION_STATUSES)',
    );
    expect(expiry).toContain(
      '.where("operations.status", "in", NONTERMINAL_OPERATION_STATUSES)',
    );
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
    const termination = database.slice(
      database.indexOf("async function terminateAgentSessionTransaction("),
      database.indexOf("export class PostgresDatabase"),
    );
    const cancellationBoundary = `${cancellation}\n${termination}`;

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
    expect(cancellationBoundary).toContain(
      "request?.requestedByHumanId !== input.requestedByHumanId",
    );
    expect(termination.indexOf('.updateTable("sessionCredentials")')).toBeLessThan(
      termination.indexOf('.updateTable("agentSessions")'),
    );
  });

  it("atomically revokes a linked predecessor when its replacement is claimed", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const creation = database.slice(
      database.indexOf("async createAgentSessionRequest("),
      database.indexOf("async sessionRequestForApproval("),
    );
    const claim = database.slice(
      database.indexOf("async claimAgentSessionRequest("),
      database.indexOf("async findSessionCredentialPrincipal("),
    );
    const termination = database.slice(
      database.indexOf("async function terminateAgentSessionTransaction("),
      database.indexOf("export class PostgresDatabase"),
    );

    expect(creation).toContain('input.predecessorSessionId');
    expect(creation).toContain('.where("agentSessions.status", "=", "active")');
    expect(creation).toContain('input.predecessorMode === "renewal"');
    expect(creation).toContain(
      'input.predecessorMode === "host_shell_escalation"',
    );
    expect(creation).toContain('"agentSessionRequests.requestedByHumanId"');
    expect(creation).toContain("input.humanId");
    expect(claim).toContain("withDatabaseDeadlockRetry");
    expect(claim).toContain("terminateAgentSessionTransaction(transaction");
    expect(claim).toContain('reason: "revoked"');
    expect(claim).toContain("requireUnexpiredAt: input.now");
    expect(claim).toContain('status: "predecessor_unavailable"');
    expect(claim.indexOf("terminateAgentSessionTransaction(transaction")).toBeLessThan(
      claim.indexOf('.insertInto("agentSessions")'),
    );
    expect(termination).toContain('.updateTable("sessionCredentials")');
    expect(termination).toContain('.updateTable("mcpSessionGrants")');
    expect(termination).toContain('.updateTable("operations")');
    expect(termination).toContain('.updateTable("sessions")');
    expect(termination).toContain("session.expiresAt <= new Date(input.requireUnexpiredAt)");
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

  it("recovers Sessions for their Workspace and durable Agent identity", () => {
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
    expect(listing).not.toContain('.where("requestedByHumanId", "=", humanId)');
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

  it("enforces the Cloud active-Agent entitlement on every canonical creation path", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );
    const approval = database.slice(
      database.indexOf("async approveAgentDeviceAuthorization("),
      database.indexOf("async exchangeAgentDeviceAuthorization("),
    );
    const entitlement = database.slice(
      database.indexOf("async function activeAgentEntitlementDecision("),
      database.indexOf("type CanonicalSessionReconciliation"),
    );
    const managedCreation = database.slice(
      database.indexOf("async createManagedAgent("),
      database.indexOf("async listManagedAgents("),
    );
    const mcpInstallation = database.slice(
      database.indexOf("async ensureMcpInstallation("),
      database.indexOf("async getAgentIdentity("),
    );
    const sessionRequest = database.slice(
      database.indexOf("async createAgentSessionRequest("),
      database.indexOf("async getAgentSessionRequest("),
    );
    const endpoint = server.slice(
      server.indexOf('"/v1/internal/cloud/agent-device/approve"'),
      server.indexOf('"/v1/internal/cloud/agent-policies/inspect"'),
    );

    expect(entitlement).toContain("pg_advisory_xact_lock");
    expect(entitlement).toContain('.innerJoin("organizations"');
    expect(entitlement).toContain("entitlementsFor(plan).activeAgentLimit");
    expect(entitlement).toContain('.selectFrom("agents")');
    expect(entitlement).toContain('.where("deletedAt", "is", null)');
    expect(entitlement).toContain('.where("status", "=", "active")');
    expect(approval.indexOf("activeAgentEntitlementDecision(")).toBeLessThan(
      approval.indexOf('.insertInto("agents")'),
    );
    expect(endpoint).toContain('error: "agent_limit_reached"');
    expect(endpoint).toContain("activeAgentLimit");
    expect(managedCreation).toContain("activeAgentEntitlementDecision(");
    expect(managedCreation).toContain('status: "agent_limit_reached"');
    expect(managedCreation).toContain('status: "created"');
    expect(mcpInstallation).toContain("lockActiveAgentEntitlement(");
    expect(mcpInstallation).toContain(
      "activeAgentEntitlementDecisionAfterLock(",
    );
    expect(sessionRequest).toContain("lockActiveAgentEntitlement(");
    expect(sessionRequest).toContain(
      "activeAgentEntitlementDecisionAfterLock(",
    );
    expect(mcpInstallation.indexOf("lockActiveAgentEntitlement(")).toBeLessThan(
      mcpInstallation.indexOf('.insertInto("humans")'),
    );
    expect(sessionRequest.indexOf("lockActiveAgentEntitlement(")).toBeLessThan(
      sessionRequest.indexOf('.insertInto("humans")'),
    );
    expect(database).not.toContain("async createAgentIdentity(");
    expect(database.match(/\.insertInto\("agents"\)/gu)).toHaveLength(4);
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
    const recentHostShell = database.slice(
      database.indexOf("async recentHostShellCommands("),
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
    expect(recentHostShell).toContain('.where("workspaceId", "=", workspaceId)');
    expect(recentHostShell).toContain('operation.action.kind === "host.shell"');
    expect(recentHostShell).not.toContain("operationEvents");
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
