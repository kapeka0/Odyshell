export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { identityMigrationsEnabled, runIdentityMigrations } = await import(
    "@/lib/identity-migrations"
  );
  if (!identityMigrationsEnabled(process.env)) return;
  await runIdentityMigrations(process.env);
}
