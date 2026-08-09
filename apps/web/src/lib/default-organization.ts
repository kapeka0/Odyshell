import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

type DeploymentMode = "cloud" | "self-hosted";

export async function defaultOrganizationForUser(options: {
  database: Pool;
  deploymentMode: DeploymentMode;
  userId: string;
  createOrganization: (input: {
    userId: string;
    name: string;
    slug: string;
  }) => Promise<{ id: string }>;
}): Promise<string> {
  const client = await options.database.connect();
  try {
    await client.query("begin");
    const lockKey = options.deploymentMode === "self-hosted"
      ? "odyshell:self-hosted-organization"
      : `odyshell:user:${options.userId}`;
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [lockKey],
    );

    const membership = await client.query<{ organizationId: string }>(
      `select "organizationId"
       from member
       where "userId" = $1
       order by "createdAt" asc
       limit 1`,
      [options.userId],
    );
    const existingOrganizationId = membership.rows[0]?.organizationId;
    if (existingOrganizationId) {
      await client.query("commit");
      return existingOrganizationId;
    }

    if (options.deploymentMode === "self-hosted") {
      const existing = await client.query<{ exists: boolean }>(
        "select exists(select 1 from organization) as exists",
      );
      if (existing.rows[0]?.exists) {
        throw new Error(
          "This self-hosted deployment already has its sovereign Organization",
        );
      }
    }

    const user = await client.query<{ name: string }>(
      'select name from "user" where id = $1 limit 1',
      [options.userId],
    );
    const name = user.rows[0]?.name.trim();
    if (!name) throw new Error("A named Human identity is required");

    const organization = await options.createOrganization({
      userId: options.userId,
      name,
      slug: defaultOrganizationSlug(name),
    });
    await client.query("commit");
    return organization.id;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export function defaultOrganizationSlug(
  name: string,
  suffix: string = randomUUID(),
): string {
  const prefix = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "organization";
  return `${prefix}-${suffix.slice(0, 8)}`;
}
