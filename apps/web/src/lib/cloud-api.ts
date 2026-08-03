import {
  DEFAULT_CLOUD_SERVER_URL,
  type Capability,
} from "@odyshell/protocol";
import { z } from "zod";

export { DEFAULT_CLOUD_SERVER_URL };

const cloudIdentitySchema = z.object({
  userId: z.string().min(1),
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
};

export type CloudSession = {
  id: string;
  agentId: string;
  agentName?: string;
  purpose: string;
  status: "active" | "completed" | "cancelled" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
  updatedAt?: string;
  requestedByHumanId?: string;
  requestedByAgentId?: string | null;
  runId?: string | null;
  predecessorSessionId?: string;
  scopes?: Array<{
    machineId: string;
    profile: string;
    capabilities: Capability[];
    restrictions: Record<string, unknown>;
  }>;
  targets: Array<{
    machineId: string;
    machineName: string;
    status: string;
  }>;
};

export type CloudSessionRequest = {
  id: string;
  agentId: string;
  agentName: string;
  purpose: string;
  durationSeconds: number;
  status: "pending" | "approved" | "denied" | "expired";
  expiresAt: string;
  createdAt: string;
  requestedByHumanId: string;
  requestedByAgentId?: string | null;
  runId?: string | null;
  machines: Array<{ id: string; name: string }>;
  approvalUrl?: string;
};

export type CloudMember = {
  id: string;
  name: string;
  imageUrl?: string;
};

export type CloudAgentPolicy = {
  id: string;
  agentId: string;
  version: number;
  kind: "autoapproval" | "delegation" | "managed";
  status: "proposed" | "active" | "paused" | "revoked" | "replaced";
  scopes: Array<{
    machineId: string;
    profile: string;
    capabilities: Capability[];
    restrictions: Record<string, unknown>;
  }>;
  maxSessionSeconds: number;
  maxManagedAgents?: number;
  expiresAt: string;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionTimelineEvent = {
  id: string;
  eventType: string;
  source: "verified" | "agent";
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SessionTimelineDetail = {
  session: CloudSession;
  timeline: SessionTimelineEvent[];
};

export type CloudEventSink = {
  id: string;
  endpoint: string;
  detailLevel: "privacy-minimal" | "operational" | "diagnostic";
  signingSecret: string;
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
};

export type CloudEventSinkState = {
  data: CloudEventSink | null;
  deliveries: Array<{
    id: string;
    eventId: string;
    status: "pending" | "retrying" | "delivered" | "failed";
    attempts: number;
    lastError?: string;
  }>;
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
  };
  createdAt: string | null;
};

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
  sessions: CloudSession[];
  sessionRequests: CloudSessionRequest[];
  members: CloudMember[];
  policies: CloudAgentPolicy[];
  controlEvents: ControlEvent[];
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
    process.env.ODYSHELL_SERVER_URL ??
    DEFAULT_CLOUD_SERVER_URL
  );
}
