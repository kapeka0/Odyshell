import { ActivationShell } from "@/components/activation-shell";

const messages: Record<string, string> = {
  agent_policy_expired: "This policy has expired.",
  agent_policy_already_used: "This policy was already reviewed.",
  agent_policy_not_found: "This policy is unavailable.",
  approval_failed: "The policy could not be approved.",
};

export default async function AgentPolicyApprovalErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string | string[] }>;
}) {
  const params = await searchParams;
  const reason =
    typeof params.reason === "string" ? params.reason : "approval_failed";
  return (
    <ActivationShell
      title="Approval failed"
      description={messages[reason] ?? messages.approval_failed}
    >
      <p className="text-sm text-muted-foreground">
        Ask the Agent to propose a new policy.
      </p>
    </ActivationShell>
  );
}
