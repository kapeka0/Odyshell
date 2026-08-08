import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";
import { safeAuthRedirect } from "@/lib/auth-redirect";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}) {
  const params = await searchParams;
  const destination = safeAuthRedirect(params.redirect_url);

  return (
    <AuthShell
      title="Welcome back"
      description="Sign in to your Odyshell Organization."
    >
      <AuthForm mode="sign-in" destination={destination} />
    </AuthShell>
  );
}
