export type StatusTone =
  | "success"
  | "info"
  | "warning"
  | "danger"
  | "neutral";

const statusTones: Record<string, StatusTone> = {
  active: "success",
  completed: "success",
  online: "success",
  recorded: "info",
  proposed: "info",
  paused: "warning",
  cancelled: "danger",
  denied: "danger",
  revoked: "danger",
  disabled: "neutral",
  expired: "neutral",
  offline: "neutral",
  replaced: "neutral",
};

export function statusTone(status: string): StatusTone {
  return statusTones[status] ?? "neutral";
}
