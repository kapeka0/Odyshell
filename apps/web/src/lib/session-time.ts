export function formatSessionRemaining(
  expiresAt: string,
  now = Date.now(),
): string {
  const remainingSeconds = Math.max(
    0,
    Math.ceil((new Date(expiresAt).getTime() - now) / 1_000),
  );
  if (remainingSeconds === 0) return "Expired";
  const hours = Math.floor(remainingSeconds / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s left`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s left`;
  }
  return `${seconds}s left`;
}

export function formatSessionDuration(durationSeconds: number): string {
  const seconds = Math.max(0, Math.round(durationSeconds));
  if (seconds < 60) return `${seconds} sec`;
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  const hourLabel = `${hours} ${hours === 1 ? "hr" : "hrs"}`;
  return minutes === 0 ? hourLabel : `${hourLabel} ${minutes} min`;
}
