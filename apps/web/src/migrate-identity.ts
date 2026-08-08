import { runIdentityMigrations } from "./lib/identity-migrations";

async function main(): Promise<void> {
  await runIdentityMigrations(process.env);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Identity migration failed");
  process.exitCode = 1;
});
