import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertAuthorityCutoverInvariant } from "../apps/server/src/database.js";

describe("authority cutover", () => {
  it("fails closed for every partial migration state", () => {
    const complete = {
      missingWorkspaces: 0,
      activeLegacyTokens: 0,
      activeLegacySessions: 0,
      activeLegacyOperations: 0,
    };
    expect(() => assertAuthorityCutoverInvariant(complete)).not.toThrow();

    for (const field of Object.keys(complete) as Array<keyof typeof complete>) {
      expect(() =>
        assertAuthorityCutoverInvariant({ ...complete, [field]: 1 }),
      ).toThrow(/Authority cutover is incomplete/);
    }
  });

  it("revokes legacy authority without deleting machines, profiles or history", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const migration = database.slice(
      database.indexOf("async function migrateAuthorityCutover("),
      database.indexOf("async function rollbackAuthorityCutover("),
    );

    expect(migration).toContain("insert into odyshell.agents");
    expect(migration).toContain("update odyshell.agent_tokens");
    expect(migration).toContain("update odyshell.sessions");
    expect(migration).toContain("update odyshell.operations");
    expect(migration).toContain("legacy_authority_migrated");
    expect(migration).not.toContain("delete from odyshell.machines");
    expect(migration).not.toContain("delete from odyshell.audit_events");
    expect(migration).not.toContain("token_hash");
  });

  it("keeps rollback from reactivating revoked secrets", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const rollback = database.slice(
      database.indexOf("async function rollbackAuthorityCutover("),
      database.indexOf("const migrationProvider"),
    );
    expect(rollback).toContain("drop table odyshell.authority_cutovers");
    expect(rollback).not.toContain("update odyshell.agent_tokens");
    expect(rollback).not.toContain("update odyshell.sessions");
  });

  it("returns migration guidance from legacy routes", () => {
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );
    expect(server).toContain('"legacy_agent_access_migrated"');
    expect(server).toContain('"legacy_session_creation_migrated"');
    expect(server).toContain('"/v1/development/sessions"');
    expect(server).toContain('"development_credential_required"');
  });

  it("rejects development Host Shell authority before opening a Client Session", () => {
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );
    const developmentRoute = server.slice(
      server.indexOf('app.post("/v1/development/sessions"'),
      server.indexOf('app.get<{ Params: { sessionId: string } }>'),
    );

    expect(developmentRoute).toContain("developmentSessionDecision(");
    expect(developmentRoute.indexOf("developmentSessionDecision(")).toBeLessThan(
      developmentRoute.indexOf("db.createSession({"),
    );
    expect(developmentRoute.indexOf("developmentSessionDecision(")).toBeLessThan(
      developmentRoute.indexOf("gateway.send(input.machineId"),
    );
    expect(developmentRoute).toContain("error: developmentDecision.code");

    const operationRoute = server.slice(
      server.indexOf('"/v1/sessions/:sessionId/operations"'),
      server.indexOf('"/v1/operations/:operationId"'),
    );
    expect(operationRoute).toContain("developmentSessionDecision(");
    expect(operationRoute.indexOf("developmentSessionDecision(")).toBeLessThan(
      operationRoute.indexOf("db.sessionForOperation("),
    );
    expect(operationRoute.indexOf("developmentSessionDecision(")).toBeLessThan(
      operationRoute.lastIndexOf("deliverOperation("),
    );
  });
});
