import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { ActivationShell } from "@/components/activation-shell";
import { AgentPolicyApprovalForm } from "@/components/agent-policy-approval";
import {
  agentPolicyCodeSchema,
  agentPolicyErrorPath,
  type AgentPolicyApproval,
} from "@/lib/agent-policy";
import { currentCloudIdentity } from "@/lib/clerk-identity";
import { cloudRequest, CloudApiError } from "@/lib/cloud-api";

export default async function AgentPolicyApprovePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const params = await searchParams;
  const code = agentPolicyCodeSchema.safeParse(
    typeof params.code === "string" ? params.code : "",
  );
  if (!code.success) redirect(agentPolicyErrorPath());
  const { userId, orgRole } = await auth();
  if (!userId) {
    const destination = `/policies/approve?code=${encodeURIComponent(code.data)}`;
    redirect(`/sign-in?redirect_url=${encodeURIComponent(destination)}`);
  }
  if (orgRole !== "org:admin") redirect(agentPolicyErrorPath());
  const identity = await currentCloudIdentity();
  if (!identity) redirect("/onboarding");
  let policy: AgentPolicyApproval;
  try {
    policy = await cloudRequest<AgentPolicyApproval>(
      "/v1/internal/cloud/agent-policies/inspect",
      identity,
      { extraBody: { approvalCode: code.data } },
    );
  } catch (error) {
    if (error instanceof CloudApiError) {
      redirect(agentPolicyErrorPath(error.code));
    }
    throw error;
  }
  return (
    <ActivationShell
      title="Approve policy"
      description="Review the maximum access this Agent may request."
    >
      <AgentPolicyApprovalForm code={code.data} policy={policy} />
    </ActivationShell>
  );
}
