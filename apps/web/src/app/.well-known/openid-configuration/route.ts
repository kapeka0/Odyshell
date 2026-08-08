import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/lib/auth";

export const GET = oauthProviderOpenIdConfigMetadata(auth, {
  headers: { "cache-control": "public, max-age=300" },
});
