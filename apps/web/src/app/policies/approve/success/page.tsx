import { ActivationShell } from "@/components/activation-shell";

export default function AgentPolicyApprovalSuccessPage() {
  return (
    <ActivationShell
      title="Policy approved"
      description="The Agent can now request Sessions within this ceiling."
    >
      <p className="text-sm text-muted-foreground">
        You can close this page.
      </p>
    </ActivationShell>
  );
}
