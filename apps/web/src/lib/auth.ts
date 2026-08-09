import "server-only";

import { createOdyshellAuth } from "@/lib/identity-auth";

export type OdyshellAuth = ReturnType<typeof createOdyshellAuth>;

let auth: OdyshellAuth | undefined;

export function getAuth(): OdyshellAuth {
  auth ??= createOdyshellAuth(process.env);
  return auth;
}
