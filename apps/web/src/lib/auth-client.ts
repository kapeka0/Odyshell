"use client";

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import {
  identityAccessControl,
  identityRoles,
} from "@/lib/identity-permissions";

export const authClient = createAuthClient({
  plugins: [
    organizationClient({
      ac: identityAccessControl,
      roles: identityRoles,
    }),
    oauthProviderClient(),
  ],
});
