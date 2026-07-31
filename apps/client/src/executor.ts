import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  Capability,
  ClientProfile,
  OperationAction,
  SessionRestrictions,
} from "@odyshell/protocol";
import { sessionScopeSubsetDecision } from "@odyshell/protocol";

export type RunningSession = {
  id: string;
  runner: "host" | "docker";
  runtimeId: string;
  profile: ClientProfile;
  capabilities: Set<Capability>;
  restrictions: SessionRestrictions | undefined;
  expiresAt: Date;
  expiryTimer: NodeJS.Timeout;
  containerId?: string;
  containerName?: string;
};

export type OperationHooks = {
  stdout: (data: Buffer) => void;
  stderr: (data: Buffer) => void;
  result: (data: Buffer) => void;
};

export type RunningOperation = {
  child?: ChildProcessWithoutNullStreams;
  cancel: () => Promise<void>;
  done: Promise<{ exitCode: number | null }>;
};

export interface OperationExecutor {
  readonly kind: "host" | "docker";
  cleanupOrphans(): Promise<void>;
  openSession(
    sessionId: string,
    profile: ClientProfile,
    capabilities: Capability[],
    restrictions: SessionRestrictions | undefined,
    expiresAt: Date,
    onExpire: () => void,
  ): Promise<RunningSession>;
  closeSession(session: RunningSession): Promise<void>;
  execute(
    operationId: string,
    session: RunningSession,
    action: OperationAction,
    hooks: OperationHooks,
  ): Promise<RunningOperation>;
}

export function validateSessionPolicy(
  profile: ClientProfile,
  capabilities: Capability[],
  restrictions: SessionRestrictions | undefined,
  expiresAt: Date,
): number {
  const ttlMilliseconds = expiresAt.getTime() - Date.now();
  if (ttlMilliseconds <= 0 || ttlMilliseconds > profile.maxSessionTtlSeconds * 1000) {
    throw new Error("Requested session TTL violates local policy");
  }
  for (const capability of capabilities) {
    if (!profile.capabilities.includes(capability)) {
      throw new Error(`Capability ${capability} is denied by local policy`);
    }
  }
  if (profile.restrictions !== undefined) {
    if (restrictions === undefined) {
      throw new Error("Legacy unrestricted Sessions violate local restrictions");
    }
    const subset = sessionScopeSubsetDecision(
      {
        machineId: "local",
        profile: "workspace",
        capabilities,
        restrictions,
      },
      {
        machineId: "local",
        profile: "workspace",
        capabilities: profile.capabilities,
        restrictions: profile.restrictions,
      },
    );
    if (!subset.allowed) {
      throw new Error(`Requested Session scope violates local policy: ${subset.code}`);
    }
  }
  return ttlMilliseconds;
}

export function validateEnvironment(environment: Record<string, string>): void {
  for (const key of Object.keys(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment key: ${key}`);
    }
  }
}
