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
});
