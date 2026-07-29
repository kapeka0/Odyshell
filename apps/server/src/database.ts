import pg from "pg";

const { Pool } = pg;

export type Database = InstanceType<typeof Pool>;

export function createDatabase(connectionString: string): Database {
  return new Pool({ connectionString, max: 10 });
}

export async function migrate(db: Database): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS machines (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      public_key text NOT NULL,
      status text NOT NULL DEFAULT 'offline',
      runtime_info jsonb,
      last_seen_at timestamptz,
      enrolled_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE machines ADD COLUMN IF NOT EXISTS runtime_info jsonb;
    ALTER TABLE machines ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

    CREATE TABLE IF NOT EXISTS enrollment_tokens (
      token_hash text PRIMARY KEY,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS agent_tokens (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      machine_ids jsonb NOT NULL,
      capabilities jsonb NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY,
      machine_id uuid NOT NULL REFERENCES machines(id),
      principal_id text NOT NULL,
      profile text NOT NULL,
      capabilities jsonb NOT NULL,
      status text NOT NULL,
      expires_at timestamptz NOT NULL,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS operations (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES sessions(id),
      principal_id text NOT NULL,
      action jsonb NOT NULL,
      status text NOT NULL,
      timeout_seconds integer NOT NULL,
      max_output_bytes integer NOT NULL,
      exit_code integer,
      error text,
      output_truncated boolean NOT NULL DEFAULT false,
      idempotency_key text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (principal_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS operation_events (
      operation_id uuid NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      sequence integer NOT NULL,
      stream text NOT NULL,
      data bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (operation_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id bigserial PRIMARY KEY,
      principal_id text NOT NULL,
      action text NOT NULL,
      target_type text NOT NULL,
      target_id text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS sessions_machine_status_idx ON sessions(machine_id, status);
    CREATE INDEX IF NOT EXISTS operations_session_idx ON operations(session_id, created_at);
    CREATE INDEX IF NOT EXISTS audit_events_principal_created_idx
      ON audit_events(principal_id, created_at DESC);
  `);
}

export async function audit(
  db: Database,
  principalId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (principal_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [principalId, action, targetType, targetId, metadata],
  );
}
