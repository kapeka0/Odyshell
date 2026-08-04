import { accessSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const QUARANTINE_FILE = "authority-quarantine.json";

export function localAuthorityQuarantinePath(stateDirectory: string): string {
  return resolve(stateDirectory, QUARANTINE_FILE);
}

export function quarantineLocalAuthority(stateDirectory: string): void {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const path = localAuthorityQuarantinePath(stateDirectory);
  try {
    writeFileSync(
      path,
      `${JSON.stringify({
        reason: "authority_termination_unconfirmed",
        quarantinedAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600, flush: true },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function assertLocalAuthorityNotQuarantined(stateDirectory: string): void {
  const path = localAuthorityQuarantinePath(stateDirectory);
  try {
    accessSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    `authority_termination_unconfirmed: this Client Profile is quarantined. Remove and re-enroll the Profile after investigating ${path}`,
  );
}
