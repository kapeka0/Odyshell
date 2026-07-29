export type AccessEnvironment = {
  NODE_ENV?: string | undefined;
  ODYSHELL_ALLOW_DEV_CREDENTIALS?: string | undefined;
};

export function developmentCredentialsEnabled(environment: AccessEnvironment): boolean {
  return (
    environment.NODE_ENV !== "production" ||
    environment.ODYSHELL_ALLOW_DEV_CREDENTIALS === "true"
  );
}

export function boundedSessionExpiry(
  now: Date,
  requestedTtlSeconds: number,
  principalExpiresAt: Date | null,
): Date {
  const requestedExpiresAt = new Date(now.getTime() + requestedTtlSeconds * 1_000);
  if (!principalExpiresAt) return requestedExpiresAt;
  return new Date(Math.min(requestedExpiresAt.getTime(), principalExpiresAt.getTime()));
}
