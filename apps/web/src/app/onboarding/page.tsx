import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { OrganizationOnboarding } from "@/components/organization-onboarding";
import { currentHumanSession } from "@/lib/identity";

export default async function OnboardingPage() {
  const session = await currentHumanSession();
  if (!session) redirect("/sign-in?redirect_url=%2Fonboarding");

  return (
    <AuthShell
      title="Choose an organization"
      description="Select an existing organization or create your first one."
    >
      <OrganizationOnboarding />
    </AuthShell>
  );
}
