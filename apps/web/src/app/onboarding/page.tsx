import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { WorkspaceOnboarding } from "@/components/workspace-onboarding";

export default async function OnboardingPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=%2Fonboarding");

  return (
    <AuthShell
      title="Choose a workspace"
      description="Select an existing workspace or create your first one."
    >
      <WorkspaceOnboarding />
    </AuthShell>
  );
}
