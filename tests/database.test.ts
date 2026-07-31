import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase } from "../apps/server/src/database.js";

describe("server storage boundaries", () => {
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
      "check (capabilities = '[\"fs.read\"]'::jsonb)",
    );
    expect(requestCreation).toContain('.where("workspaceId", "=", input.workspaceId)');
    expect(requestCreation).toContain('.where("createdByHumanId", "=", input.humanId)');
    expect(approval).toContain(".forUpdate()");
    expect(approval).toContain('.where("workspaceId", "=", input.workspaceId)');
    expect(claim).toContain(".forUpdate()");
    expect(claim).toContain(
      "request.requestedByHumanId !== input.humanId",
    );
    expect(claim).toContain('.insertInto("sessionCredentials")');
    expect(claim).not.toContain("sessionToken");
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
});
