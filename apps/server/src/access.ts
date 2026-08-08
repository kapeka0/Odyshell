import { randomBytes } from "node:crypto";

export function createEnrollmentToken(): string {
  return `ods_enroll_${randomBytes(32).toString("base64url")}`;
}
