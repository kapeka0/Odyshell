import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";

export async function GET(request: Request) {
  return oauthProviderAuthServerMetadata(getAuth(), {
    headers: { "cache-control": "public, max-age=300" },
  })(request);
}
