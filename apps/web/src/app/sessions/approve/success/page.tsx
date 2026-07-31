import { ActivationShell } from "@/components/activation-shell";

export default async function SessionApprovalSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ decision?: string }>;
}) {
  const denied = (await searchParams).decision === "deny";
  return (
    <ActivationShell
      title={denied ? "Access denied" : "Access approved"}
      description={
        denied
          ? "You can close this page. No credential was issued."
          : "You can close this page. The agent can continue."
      }
    >
      <p className="text-sm text-muted-foreground">
        {denied
          ? "The request can no longer be claimed."
          : "The credential is scoped, temporary and delivered only to the requesting runtime."}
      </p>
    </ActivationShell>
  );
}
