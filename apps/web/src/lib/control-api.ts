import {
  DEFAULT_SERVER_URL,
} from "@odyshell/protocol";
import { z } from "zod";

export { DEFAULT_SERVER_URL };

const controlIdentitySchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["owner", "admin", "supervisor"]),
  organization: z.object({
    externalId: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
  }),
});

export type ControlIdentity = z.infer<typeof controlIdentitySchema>;

export type ControlMachine = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  runtime: unknown;
  lastSeenAt: string | null;
  enrolledAt: string;
  online: boolean;
};

export type ControlAgent = {
  id: string;
  name: string;
  role: "standard" | "operator";
  status: "active" | "disabled";
  credentialActive: boolean;
  createdAt: string;
};

export type ControlMember = {
  id: string;
  name: string;
  imageUrl?: string;
};

export type ControlSession = {
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

export type ControlCommand = {
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

export type ControlSessionTimeline = {
  session: ControlSession;
  commands: ControlCommand[];
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

export type ControlNotification = {
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

export type ControlContext = {
  currentMemberRole: "owner" | "admin" | "supervisor";
  organization: {
    id: string;
    slug: string;
    name: string;
    avatarSeed: string;
  };
  userPreferences: {
    timeZone: string;
  };
  auditRetentionDays: number;
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
  machines: ControlMachine[];
  agents: ControlAgent[];
  sessions: ControlSession[];
  members: ControlMember[];
  controlEvents: ControlEvent[];
  notifications: ControlNotification[];
};

export class ControlApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(code);
    this.name = "ControlApiError";
  }
}

export async function controlRequest<T>(
  path: string,
  identity: ControlIdentity,
  options: { extraBody?: Record<string, unknown> } = {},
): Promise<T> {
  const parsedIdentity = controlIdentitySchema.parse(identity);
  const serverUrl =
    process.env.ODYSHELL_SERVER_URL ??
    process.env.NEXT_PUBLIC_ODYSHELL_SERVER_URL ??
    DEFAULT_SERVER_URL;
  const webKey = process.env.ODYSHELL_WEB_KEY;
  if (!webKey) {
    throw new ControlApiError(503, "web_key_not_configured");
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
    throw new ControlApiError(response.status || 502, "invalid_control_response");
  }
  if (!response.ok) {
    throw new ControlApiError(response.status, body.error ?? "control_request_failed", body.details);
  }
  return body;
}

export function publicServerUrl(): string {
  return (
    process.env.NEXT_PUBLIC_ODYSHELL_SERVER_URL ??
    DEFAULT_SERVER_URL
  );
}
