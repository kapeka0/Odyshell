import type {
  AgentTokenRequest,
  Capability,
} from "@odyshell/protocol";
import type { AgentTokenRecord } from "./database.js";

type Audit = (
  workspaceId: string,
  principalId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>,
) => Promise<void>;

export type AgentAccessDependencies = {
  activeMachinesExist(
    workspaceId: string,
    machineIds: string[],
  ): Promise<boolean>;
  createAgentToken(input: {
    workspaceId: string;
    id: string;
    name: string;
    tokenHash: string;
    machineIds: string[];
    capabilities: Capability[];
    expiresAt: number;
  }): Promise<
    | { created: true }
    | {
        created: false;
        plan: string;
        activeAgentLimit: number;
      }
  >;
  revokeAgentToken(
    workspaceId: string,
    tokenId: string,
  ): Promise<AgentTokenRecord | null>;
  deleteAgentToken(
    workspaceId: string,
    tokenId: string,
  ): Promise<{
    token: AgentTokenRecord;
    closedSessions: number;
  } | null>;
  expireAgentSessions(
    workspaceId: string,
    principalId: string,
    reason: string,
  ): Promise<number>;
  audit: Audit;
  createId(): string;
  createToken(): string;
  hashToken(token: string): string;
  now(): number;
};

export async function createAgentAccess(
  dependencies: AgentAccessDependencies,
  workspaceId: string,
  principalId: string,
  input: AgentTokenRequest,
): Promise<
  | { status: "unknown_machine" }
  | { status: "limit_reached"; plan: string; activeAgentLimit: number }
  | {
      status: "created";
      access: {
        id: string;
        name: string;
        token: string;
        machineIds: string[];
        capabilities: Capability[];
        expiresAt: string;
      };
    }
> {
  const machineIds = [...new Set(input.machineIds)];
  const capabilities = [...new Set(input.capabilities)];
  if (!(await dependencies.activeMachinesExist(workspaceId, machineIds))) {
    return { status: "unknown_machine" };
  }

  const id = dependencies.createId();
  const token = dependencies.createToken();
  const expiresAt = new Date(
    dependencies.now() + input.expiresInSeconds * 1_000,
  );
  const creation = await dependencies.createAgentToken({
    workspaceId,
    id,
    name: input.name,
    tokenHash: dependencies.hashToken(token),
    machineIds,
    capabilities,
    expiresAt: expiresAt.getTime(),
  });
  if (!creation.created) {
    return {
      status: "limit_reached",
      plan: creation.plan,
      activeAgentLimit: creation.activeAgentLimit,
    };
  }

  await dependencies.audit(
    workspaceId,
    principalId,
    "agent_token.created",
    "agent_token",
    id,
    {
      name: input.name,
      machineIds,
      capabilities,
      expiresAt: expiresAt.toISOString(),
    },
  );
  return {
    status: "created",
    access: {
      id,
      name: input.name,
      token,
      machineIds,
      capabilities,
      expiresAt: expiresAt.toISOString(),
    },
  };
}

export async function revokeAgentAccess(
  dependencies: AgentAccessDependencies,
  workspaceId: string,
  principalId: string,
  tokenId: string,
): Promise<{
  id: string;
  name: string;
  status: "revoked";
  revokedAt: string | null;
  closedSessions: number;
} | null> {
  const token = await dependencies.revokeAgentToken(workspaceId, tokenId);
  if (!token) return null;
  const closedSessions = await dependencies.expireAgentSessions(
    workspaceId,
    token.id,
    "agent_token_revoked",
  );
  const revokedAt = token.revokedAt
    ? new Date(token.revokedAt).toISOString()
    : null;
  await dependencies.audit(
    workspaceId,
    principalId,
    "agent_token.revoked",
    "agent_token",
    token.id,
    {
      name: token.name,
      revokedAt,
      closedSessions,
    },
  );
  return {
    id: token.id,
    name: token.name,
    status: "revoked",
    revokedAt,
    closedSessions,
  };
}

export async function deleteAgentAccess(
  dependencies: AgentAccessDependencies,
  workspaceId: string,
  principalId: string,
  tokenId: string,
): Promise<{
  id: string;
  name: string;
  status: "deleted";
  closedSessions: number;
} | null> {
  const deletion = await dependencies.deleteAgentToken(workspaceId, tokenId);
  if (!deletion) return null;

  await dependencies.audit(
    workspaceId,
    principalId,
    "agent_token.deleted",
    "agent_token",
    deletion.token.id,
    {
      name: deletion.token.name,
      closedSessions: deletion.closedSessions,
    },
  );
  return {
    id: deletion.token.id,
    name: deletion.token.name,
    status: "deleted",
    closedSessions: deletion.closedSessions,
  };
}
