const SECOND = 1_000;
const DAY = 24 * 60 * 60 * SECOND;

export type DataRetentionPolicy = {
  transientDataMilliseconds: number;
  auditMilliseconds: number;
};

function integerSetting(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function dataRetentionPolicy(
  environment: NodeJS.ProcessEnv,
): DataRetentionPolicy {
  const transientDataSeconds = integerSetting(
    environment,
    "ODYSHELL_TRANSIENT_RETENTION_SECONDS",
    60 * 60,
    60,
    7 * 24 * 60 * 60,
  );
  const auditDays = integerSetting(
    environment,
    "ODYSHELL_AUDIT_RETENTION_DAYS",
    30,
    1,
    3_650,
  );
  return {
    transientDataMilliseconds: transientDataSeconds * SECOND,
    auditMilliseconds: auditDays * DAY,
  };
}
