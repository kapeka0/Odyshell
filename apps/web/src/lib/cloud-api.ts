import {
  DEFAULT_CLOUD_SERVER_URL,
} from "@odyshell/protocol";
import { z } from "zod";

export { DEFAULT_CLOUD_SERVER_URL };

const cloudIdentitySchema = z.object({
  userId: z.string().min(1),
  userName: z.string().trim().min(1).max(128).optional(),
  role: z.enum(["owner", "admin", "supervisor"]),
  organization: z.object({
    externalId: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
  }),
});

export type CloudIdentity = z.infer<typeof cloudIdentitySchema>;

export type CloudMachine = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  runtime: unknown;
  lastSeenAt: string | null;
  enrolledAt: string;
  online: boolean;
};

export type CloudAgent = {
  id: string;
  name: string;
  kind: "independent" | "managed";
  status: "active" | "disabled";
  parentAgentId: string | null;
  credentialActive: boolean;
  createdAt: string;
};

export type CloudMember = {
  id: string;
  name: string;
  imageUrl?: string;
};

export type CloudTask = {
  id: string;
  organizationId: string;
  agentId: string;
  machineId: string;
  clientProfileId: string;
  operatingSystemUser: string;
  title: string;
  purpose: string | null;
  status:
    | "pending_approval"
    | "opening"
    | "active"
    | "completed"
    | "cancellation_requested"
    | "cancelled"
    | "revoked"
    | "expired"
    | "failed";
  maxConcurrentCommands: number;
  createdAt: string;
  readyAt: string | null;
  expiresAt: string;
  finishedAt: string | null;
};

export type ControlEvent = {
  id: string;
  principalId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: {
    kind?: string;
    reason?: string;
    machineId?: string;
    humanId?: string;
    role?: string;
    command?: string;
    cwd?: string | null;
    timeoutSeconds?: number;
    status?: string;
    outcome?: string;
    exitCode?: number | null;
  };
  createdAt: string | null;
};

export type CloudNotification = {
  id: string;
  kind:
    | "machine.enrolled"
    | "machine.offline"
    | "agent.revoked";
  title: string;
  description: string;
  href: string;
  readAt: string | null;
  createdAt: string;
};

export type CloudContext = {
  currentMemberRole: "owner" | "admin" | "supervisor";
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
    avatarSeed: string;
  };
  userPreferences: {
    timeZone: string;
  };
  plan: {
    id: "free" | "team" | "scale";
    machineLimit: number;
    workspaceLimit: number;
    activeAgentLimit: number;
    controlEventRetentionDays: number;
  };
  usage: {
    machines: number;
    workspaces: number;
    activeAgents: number;
  };
  connections: {
    activeConnections: number;
    connectedAgents: number;
    connections: Array<{
      id: string;
      machineId: string;
      agentId: string;
      agentName: string;
      status: string;
    }>;
  };
  machines: CloudMachine[];
  agents: CloudAgent[];
  tasks: CloudTask[];
  members: CloudMember[];
  controlEvents: ControlEvent[];
  notifications: CloudNotification[];
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
    DEFAULT_CLOUD_SERVER_URL;
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
    DEFAULT_CLOUD_SERVER_URL
  );
}
