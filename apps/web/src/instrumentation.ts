export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const [{ getMigrations }, { Pool }, { auth }] = await Promise.all([
    import("better-auth/db/migration"),
    import("pg"),
    import("@/lib/auth"),
  ]);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for identity migrations");

  const lockPool = new Pool({
    connectionString: databaseUrl,
    options: "-c search_path=public",
    max: 1,
  });
  const lock = await lockPool.connect();
  try {
    await lock.query(
      "select pg_advisory_lock(hashtext('odyshell:better-auth-schema'))",
    );
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
  } finally {
    await lock
      .query("select pg_advisory_unlock(hashtext('odyshell:better-auth-schema'))")
      .catch(() => undefined);
    lock.release();
    await lockPool.end();
  }
}
