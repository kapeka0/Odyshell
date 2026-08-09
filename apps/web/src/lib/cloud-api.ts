import {
  DEFAULT_CLOUD_SERVER_URL,
} from "@odyshell/protocol";
import { z } from "zod";

export { DEFAULT_CLOUD_SERVER_URL };

const cloudIdentitySchema = z.object({
  userId: z.string().min(1),
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
  role: "standard" | "operator";
  status: "active" | "disabled";
  credentialActive: boolean;
  createdAt: string;
};

export type CloudMember = {
  id: string;
  name: string;
  imageUrl?: string;
};

export type CloudSession = {
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

export type CloudCommand = {
  id: string;
  sessionId: string;
  organizationId: string;
  agentId: string;
  machineId: string;
  command: string;
  cwd: string | null;
  timeoutSeconds: number;
  status: "queued" | "delivered" | "running" | "cancellation_requested" | "succeeded" | "failed" | "cancelled" | "timed_out" | "execution_unknown";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  outputTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  error: string | null;
  output: Array<{ sequence: number; stream: "stdout" | "stderr"; dataBase64: string }>;
};

export type CloudSessionTimeline = {
  session: CloudSession;
  commands: CloudCommand[];
  events: Array<{
    id: string;
    agentId: string;
    sessionId: string;
    commandId: string | null;
    type: string;
    metadata: Record<string, unknown>;
    createdAt: string;
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
    humanId?: string;
    role?: string;
    command?: string;
    cwd?: string | null;
    timeoutSeconds?: number;
    status?: string;
    outcome?: string;
    exitCode?: number | null;
    from?: string;
    to?: string;
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
    plan: "free" | "pro" | "enterprise";
    avatarSeed: string;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
  };
  userPreferences: {
    timeZone: string;
  };
  plan: {
    id: "free" | "pro" | "enterprise";
    billingManaged: boolean;
    memberLimit: number | null;
    machineLimit: number;
    activeAgentLimit: number | null;
    monthlyPricePerMemberCents: number | null;
    controlEventRetentionDays: number;
  };
  usage: {
    machines: number;
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
