import { z } from "zod";
import type { SessionMachineScope } from "@odyshell/protocol";

export const sessionApprovalRequestIdSchema = z.string().trim().uuid();

export type SessionApproval = {
  id: string;
  agent: { id: string; name: string };
  purpose?: string;
  predecessorSessionId: string | null;
  scopes: Array<
    SessionMachineScope & {
      machine: { id: string; name: string };
      readiness: { ready: true } | { ready: false; reason: string };
    }
  >;
  durationSeconds: number;
  status: "pending" | "approved" | "expired" | "claimed";
  expiresAt: string;
};

export function sessionApprovalErrorPath(code?: string): string {
  const known = new Set([
    "session_request_expired",
    "session_request_already_used",
    "session_request_not_found",
  ]);
  const reason = code && known.has(code) ? code : "approval_failed";
  return `/sessions/approve/error?reason=${encodeURIComponent(reason)}`;
}
