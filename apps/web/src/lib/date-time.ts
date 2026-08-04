export function dashboardTimeZone(timeZone: string): string | undefined {
  return timeZone === "System" ? undefined : timeZone;
}

export function formatDashboardTimestamp(
  value: string | null | undefined,
  timeZone: string,
): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: dashboardTimeZone(timeZone),
  }).format(new Date(value));
}
