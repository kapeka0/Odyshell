import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";
import { createOdyshellAuth } from "./identity-auth";

const migrationLockName = "odyshell:better-auth-schema";

export function identityMigrationsEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  const configured = environment.ODYSHELL_RUN_IDENTITY_MIGRATIONS;
  if (
    configured !== undefined &&
    configured !== "true" &&
    configured !== "false"
  ) {
    throw new Error("ODYSHELL_RUN_IDENTITY_MIGRATIONS must be true or false");
  }
  if (configured !== undefined) return configured === "true";
  return environment.ODYSHELL_DEPLOYMENT_MODE !== "cloud";
}

export async function runIdentityMigrations(
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for identity migrations");
  }

  const lockPool = new Pool({
    connectionString: databaseUrl,
    options: "-c search_path=public",
    max: 1,
  });
  const migrationPool = new Pool({
    connectionString: databaseUrl,
    options: "-c search_path=public",
  });
  const lock = await lockPool.connect();
  try {
    await lock.query("select pg_advisory_lock(hashtext($1))", [
      migrationLockName,
    ]);
    const auth = createOdyshellAuth(environment, migrationPool);
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
  } finally {
    await lock
      .query("select pg_advisory_unlock(hashtext($1))", [migrationLockName])
      .catch(() => undefined);
    lock.release();
    await migrationPool.end();
    await lockPool.end();
  }
}
