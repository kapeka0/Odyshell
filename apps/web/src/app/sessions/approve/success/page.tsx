import { ActivationShell } from "@/components/activation-shell";

export default function SessionApprovalSuccessPage() {
  return (
    <ActivationShell
      title="Access approved"
      description="You can close this page. The agent can continue."
    >
      <p className="text-sm text-muted-foreground">
        The credential is scoped, temporary and delivered only to the requesting
        MCP process.
      </p>
    </ActivationShell>
  );
}
