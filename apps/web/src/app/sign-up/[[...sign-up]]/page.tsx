import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";
import { safeAuthRedirect } from "@/lib/auth-redirect";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}) {
  const params = await searchParams;
  const destination = safeAuthRedirect(params.redirect_url);

  return (
    <AuthShell
      title="Create your workspace"
      description="Start with a private machine and scoped agent access."
    >
      <AuthForm mode="sign-up" destination={destination} />
    </AuthShell>
  );
}
