import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { ActivationShell } from "@/components/activation-shell";
import { AgentActivation } from "@/components/agent-activation";
import { currentCloudIdentity } from "@/lib/clerk-identity";
import { cloudRequest } from "@/lib/cloud-api";
import { deviceCodeSchema } from "@/lib/device-activation";

export default async function ActivateAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const params = await searchParams;
  const parsed = deviceCodeSchema.safeParse(
    typeof params.code === "string" ? params.code : "",
  );
  if (!parsed.success) redirect("/activate-agent/error");
  const { userId, orgRole } = await auth();
  if (!userId) {
    const destination = `/activate-agent?code=${encodeURIComponent(parsed.data)}`;
    redirect(`/sign-in?redirect_url=${encodeURIComponent(destination)}`);
  }
  if (orgRole !== "org:admin") redirect("/activate-agent/error");
  const identity = await currentCloudIdentity();
  if (!identity) redirect("/activate-agent/error");
  const approval = await cloudRequest<{ agentName: string; expiresAt: string }>(
    "/v1/internal/cloud/agent-device/inspect",
    identity,
    { extraBody: { userCode: parsed.data } },
  ).catch(() => null);
  if (!approval) redirect("/activate-agent/error");
  return (
    <ActivationShell
      title="Register Agent"
      description="Confirm the Agent identity requested by the runtime."
    >
      <AgentActivation code={parsed.data} agentName={approval.agentName} />
    </ActivationShell>
  );
}
