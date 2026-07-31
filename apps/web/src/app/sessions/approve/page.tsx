import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { ActivationShell } from "@/components/activation-shell";
import { SessionApprovalForm } from "@/components/session-approval";
import { cloudRequest, CloudApiError } from "@/lib/cloud-api";
import { currentCloudIdentity } from "@/lib/clerk-identity";
import {
  sessionApprovalCodeSchema,
  sessionApprovalErrorPath,
  type SessionApproval,
} from "@/lib/session-approval";

export default async function SessionApprovePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const params = await searchParams;
  const parsedCode = sessionApprovalCodeSchema.safeParse(
    typeof params.code === "string" ? params.code : "",
  );
  if (!parsedCode.success) redirect(sessionApprovalErrorPath());

  const { userId } = await auth();
  if (!userId) {
    const destination = `/sessions/approve?code=${encodeURIComponent(parsedCode.data)}`;
    redirect(`/sign-in?redirect_url=${encodeURIComponent(destination)}`);
  }
  const identity = await currentCloudIdentity();
  if (!identity) redirect("/onboarding");

  let approval: SessionApproval;
  try {
    approval = await cloudRequest<SessionApproval>(
      "/v1/internal/cloud/session-requests/inspect",
      identity,
      { extraBody: { approvalCode: parsedCode.data } },
    );
  } catch (error) {
    if (error instanceof CloudApiError) {
      redirect(sessionApprovalErrorPath(error.code));
    }
    throw error;
  }

  return (
    <ActivationShell
      title="Approve agent access"
      description="Review the exact temporary access requested."
    >
      <SessionApprovalForm code={parsedCode.data} approval={approval} />
    </ActivationShell>
  );
}
