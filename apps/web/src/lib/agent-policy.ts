import type { SessionMachineScope } from "@odyshell/protocol";
import { z } from "zod";

export const agentPolicyCodeSchema = z
  .string()
  .trim()
  .regex(/^ods_policy_[A-Za-z0-9_-]{20,}$/);

export type AgentPolicyApproval = {
  id: string;
  version: number;
  agent: { id: string; name: string };
  scopes: Array<
    SessionMachineScope & { machine: { id: string; name: string } }
  >;
  maxSessionSeconds: number;
  expiresAt: string;
};

export function agentPolicyErrorPath(code?: string): string {
  const known = new Set([
    "agent_policy_expired",
    "agent_policy_already_used",
    "agent_policy_not_found",
  ]);
  return `/policies/approve/error?reason=${encodeURIComponent(
    code && known.has(code) ? code : "approval_failed",
  )}`;
}
