import { z } from "zod";

export const sessionApprovalCodeSchema = z
  .string()
  .trim()
  .regex(/^ods_approval_[A-Za-z0-9_-]{20,}$/);

export type SessionApproval = {
  id: string;
  agent: { id: string; name: string };
  machine: { id: string; name: string };
  purpose: string;
  capability: "fs.read";
  path: string;
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
