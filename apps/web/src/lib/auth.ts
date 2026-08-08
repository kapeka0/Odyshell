import "server-only";

import { createOdyshellAuth } from "@/lib/identity-auth";

export const auth = createOdyshellAuth(process.env);

export type OdyshellAuth = typeof auth;
