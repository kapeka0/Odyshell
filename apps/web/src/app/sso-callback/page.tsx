import { AuthSsoCallback } from "@/components/auth-sso-callback";
import { safeAuthRedirect } from "@/lib/auth-redirect";

export default async function SsoCallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}) {
  const params = await searchParams;
  const destination = safeAuthRedirect(params.redirect_url);

  return <AuthSsoCallback destination={destination} />;
}
