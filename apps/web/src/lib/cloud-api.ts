import { z } from "zod";

const cloudIdentitySchema = z.object({
  userId: z.string().min(1),
  organization: z.object({
    externalId: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
  }),
});

export type CloudIdentity = z.infer<typeof cloudIdentitySchema>;

export type CloudContext = {
  organization: {
    id: string;
    slug: string;
    name: string;
    plan: "free" | "team" | "scale";
  };
  workspace: {
    id: string;
    organizationId: string;
    slug: string;
    name: string;
  };
  plan: {
    id: "free" | "team" | "scale";
    machineLimit: number;
    workspaceLimit: number;
    activeAgentLimit: number;
  };
  usage: {
    machines: number;
    workspaces: number;
    activeAgents: number;
  };
  machines: Array<{
    id: string;
    name: string;
    status: string;
    runtime: unknown;
    lastSeenAt: string | null;
    enrolledAt: string;
    online: boolean;
  }>;
};

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(code);
    this.name = "CloudApiError";
  }
}

export async function cloudRequest<T>(
  path: string,
  identity: CloudIdentity,
  options: { extraBody?: Record<string, unknown> } = {},
): Promise<T> {
  const parsedIdentity = cloudIdentitySchema.parse(identity);
  const serverUrl =
    process.env.ODYSHELL_SERVER_URL ??
    process.env.NEXT_PUBLIC_ODYSHELL_SERVER_URL ??
    "http://127.0.0.1:4100";
  const webKey = process.env.ODYSHELL_WEB_KEY;
  if (!webKey) {
    throw new CloudApiError(503, "web_key_not_configured");
  }

  const response = await fetch(new URL(path, serverUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-odyshell-web-key": webKey,
    },
    body: JSON.stringify({
      ...parsedIdentity,
      ...options.extraBody,
    }),
    cache: "no-store",
  });
  const text = await response.text();
  let body: T & { error?: string; details?: unknown };
  try {
    body = (text ? JSON.parse(text) : {}) as T & {
      error?: string;
      details?: unknown;
    };
  } catch {
    throw new CloudApiError(response.status || 502, "invalid_cloud_response");
  }
  if (!response.ok) {
    throw new CloudApiError(response.status, body.error ?? "cloud_request_failed", body.details);
  }
  return body;
}

export function publicServerUrl(): string {
  return (
    process.env.NEXT_PUBLIC_ODYSHELL_SERVER_URL ??
    process.env.ODYSHELL_SERVER_URL ??
    "http://127.0.0.1:4100"
  );
}
