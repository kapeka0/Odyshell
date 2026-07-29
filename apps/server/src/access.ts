export type AccessEnvironment = {
  NODE_ENV?: string | undefined;
  ODYSHELL_ADMIN_KEY?: string | undefined;
  ODYSHELL_ALLOW_DEV_CREDENTIALS?: string | undefined;
};

const developmentAdminKey = "dev-admin-key";

export function serverAdminKey(environment: AccessEnvironment): string {
  const configuredKey = environment.ODYSHELL_ADMIN_KEY;
  if (environment.NODE_ENV === "production") {
    if (!configuredKey || configuredKey === developmentAdminKey) {
      throw new Error(
        "ODYSHELL_ADMIN_KEY must be set to a secure value when NODE_ENV=production",
      );
    }
    return configuredKey;
  }
  return configuredKey ?? developmentAdminKey;
}

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
