import { redirect } from "next/navigation";
import { ActivationShell } from "@/components/activation-shell";
import { AgentPolicyApprovalForm } from "@/components/agent-policy-approval";
import {
  agentPolicyCodeSchema,
  agentPolicyErrorPath,
  type AgentPolicyApproval,
} from "@/lib/agent-policy";
import { currentCloudIdentity, currentHumanIdentity } from "@/lib/identity";
import { cloudRequest, CloudApiError } from "@/lib/cloud-api";
import { canAdministerOrganization } from "@/lib/identity-permissions";

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
  const humanIdentity = await currentHumanIdentity();
  if (!humanIdentity) {
    const destination = `/policies/approve?code=${encodeURIComponent(code.data)}`;
    redirect(`/sign-in?redirect_url=${encodeURIComponent(destination)}`);
  }
  if (!canAdministerOrganization(humanIdentity.role)) {
    redirect(agentPolicyErrorPath());
  }
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
