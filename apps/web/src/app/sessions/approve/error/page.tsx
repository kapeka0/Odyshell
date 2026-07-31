import { ActivationShell } from "@/components/activation-shell";

const messages: Record<string, string> = {
  session_request_expired: "This request has expired.",
  session_request_already_used: "This request was already used.",
  session_request_not_found: "This request is unavailable.",
  approval_failed: "The request could not be approved.",
};

export default async function SessionApprovalErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string | string[] }>;
}) {
  const params = await searchParams;
  const reason =
    typeof params.reason === "string" ? params.reason : "approval_failed";
  return (
    <ActivationShell title="Approval failed" description={messages[reason] ?? messages.approval_failed}>
      <p className="text-sm text-muted-foreground">
        Return to the agent and create a new request.
      </p>
    </ActivationShell>
  );
}
