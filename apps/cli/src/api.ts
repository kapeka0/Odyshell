import { randomUUID } from "node:crypto";
import type {
  Capability,
  ClientRuntimeInfo,
  OperationAction,
  OperationStatus,
} from "@odyshell/protocol";
import type { StoredConfig } from "./config.js";
import { ExpectedError, ServerConnectionError } from "./errors.js";

export type Machine = {
  id: string;
  name: string;
  status: string;
  online: boolean;
  runtime?: ClientRuntimeInfo | null;
  lastSeenAt: string | null;
  enrolledAt: string;
};

export type Session = {
  id: string;
  machineId: string;
  machineName?: string;
  profile: string;
  capabilities: Capability[];
  status: string;
  expiresAt: string;
  error?: string | null;
  createdAt: string;
};

export type OperationEvent = {
  sequence: number;
  stream: "stdout" | "stderr" | "result";
  dataBase64: string;
  createdAt?: string;
};

export type Operation = {
  id: string;
  sessionId: string;
  action: OperationAction;
  status: OperationStatus;
  exitCode: number | null;
  error?: string | null;
  outputTruncated: boolean;
  events: OperationEvent[];
  createdAt: string;
  updatedAt: string;
};

export type AgentToken = {
  id: string;
  name: string;
  token: string;
  machineIds: string[];
  capabilities: Capability[];
  expiresAt: string;
};

export type AuditEvent = {
  id: string;
  principalId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export class ApiError extends ExpectedError {
  constructor(
    readonly status: number,
    code: string,
    readonly details?: unknown,
  ) {
    super(`${status} ${code}`, code);
    this.name = "ApiError";
  }
}

export class OdyshellApi {
  constructor(private readonly config: StoredConfig) {}

  get serverUrl(): string {
    return this.config.serverUrl;
  }

  async health(): Promise<{ status: string; protocol: number }> {
    return this.request("/health", { authenticated: false });
  }

  async machines(): Promise<Machine[]> {
    const response = await this.request<{ data: Machine[] }>("/v1/machines");
    return response.data;
  }

  async resolveMachine(reference: string): Promise<Machine> {
    const machines = await this.machines();
    const exact = machines.find((machine) => machine.id === reference);
    const named = machines.filter(
      (machine) => machine.name.toLocaleLowerCase() === reference.toLocaleLowerCase(),
    );
    const onlineNamed = named.filter((machine) => machine.online);
    const machine =
      exact ??
      (onlineNamed.length === 1
        ? onlineNamed[0]
        : named.length === 1
          ? named[0]
          : undefined);
    if (!machine) {
      if (onlineNamed.length > 1 || named.length > 1) {
        throw new ExpectedError(
          `Machine name "${reference}" is ambiguous; use its ID`,
          "machine_ambiguous",
        );
      }
      throw new ExpectedError(`Machine "${reference}" was not found`, "machine_not_found");
    }
    if (!machine.online) {
      throw new ExpectedError(
        `Machine "${machine.name}" is enrolled, but its Odyshell Client is not connected to the Server.`,
        "machine_offline",
      );
    }
    return machine;
  }

  async sessions(): Promise<Session[]> {
    const response = await this.request<{ data: Session[] }>("/v1/sessions");
    return response.data;
  }

  async createSession(
    machineId: string,
    capabilities: Capability[],
    ttlSeconds: number,
  ): Promise<Session> {
    return this.request("/v1/sessions", {
      method: "POST",
      body: { machineId, profile: "workspace", ttlSeconds, capabilities },
    });
  }

  async session(sessionId: string): Promise<Session> {
    return this.request(`/v1/sessions/${sessionId}`);
  }

  async closeSession(sessionId: string): Promise<{ id: string; status: string }> {
    return this.request(`/v1/sessions/${sessionId}`, { method: "DELETE" });
  }

  async waitForSession(sessionId: string): Promise<Session> {
    for (;;) {
      const session = await this.session(sessionId);
      if (session.status === "ready") return session;
      if (["failed", "closed", "expired"].includes(session.status)) {
        throw new ExpectedError(
          `Session ${session.status}: ${session.error ?? "no additional details"}`,
          `session_${session.status}`,
        );
      }
      await delay(200);
    }
  }

  async createOperation(
    sessionId: string,
    action: OperationAction,
    timeoutSeconds = 120,
    maxOutputBytes = 1024 * 1024,
  ): Promise<{ id: string; status: string }> {
    return this.request(`/v1/sessions/${sessionId}/operations`, {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: { action, timeoutSeconds, maxOutputBytes },
    });
  }

  async operation(operationId: string): Promise<Operation> {
    return this.request(`/v1/operations/${operationId}`);
  }

  async cancelOperation(operationId: string): Promise<{ id: string; status: string }> {
    return this.request(`/v1/operations/${operationId}/cancel`, { method: "POST" });
  }

  async waitForOperation(
    operationId: string,
    onEvent?: (event: OperationEvent) => void,
  ): Promise<Operation> {
    let lastSequence = -1;
    for (;;) {
      const operation = await this.operation(operationId);
      for (const event of operation.events) {
        if (event.sequence <= lastSequence) continue;
        lastSequence = event.sequence;
        onEvent?.(event);
      }
      if (!["queued", "delivered", "running"].includes(operation.status)) return operation;
      await delay(150);
    }
  }

  async createEnrollmentToken(ttlSeconds: number): Promise<{ token: string; expiresAt: string }> {
    return this.request("/v1/admin/enrollment-tokens", {
      method: "POST",
      admin: true,
      body: { expiresInSeconds: ttlSeconds },
    });
  }

  async createAgentToken(
    name: string,
    machineIds: string[],
    capabilities: Capability[],
    expiresInSeconds: number,
  ): Promise<AgentToken> {
    return this.request("/v1/admin/agent-tokens", {
      method: "POST",
      admin: true,
      body: { name, machineIds, capabilities, expiresInSeconds },
    });
  }

  async audit(limit: number): Promise<{
    principal: { id: string; name: string };
    data: AuditEvent[];
  }> {
    return this.request(`/v1/audit?limit=${encodeURIComponent(String(limit))}`);
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      admin?: boolean;
      authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const authenticated = options.authenticated ?? true;
    const credential = options.admin ? this.config.adminKey : this.config.agentToken;
    if (authenticated && !credential) {
      throw new ExpectedError(
        `No ${options.admin ? "admin key" : "agent token"} configured. Run "ods login" or set the corresponding environment variable.`,
        "credentials_missing",
      );
    }
    let response: Response;
    try {
      response = await fetch(new URL(path, this.config.serverUrl), {
        method: options.method ?? "GET",
        headers: {
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(authenticated
            ? options.admin
              ? { "x-odyshell-admin-key": credential! }
              : { authorization: `Bearer ${credential!}` }
            : {}),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw new ServerConnectionError(this.config.serverUrl, error);
    }
    const text = await response.text();
    const body = (text ? JSON.parse(text) : {}) as T & { error?: string; details?: unknown };
    if (!response.ok) {
      throw new ApiError(response.status, body.error ?? response.statusText, body.details);
    }
    return body;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
