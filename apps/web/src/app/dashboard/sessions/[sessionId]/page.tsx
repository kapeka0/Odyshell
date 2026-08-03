import { notFound, redirect } from "next/navigation";
import { SessionDetail } from "@/components/session-detail";
import { Button } from "@/components/ui/button";
import { DownloadIcon } from "lucide-react";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard-state";
import { currentCloudIdentity } from "@/lib/clerk-identity";
import {
  CloudApiError,
  cloudRequest,
  type SessionTimelineDetail,
} from "@/lib/cloud-api";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const identity = await currentCloudIdentity();
  if (!identity) redirect("/dashboard");
  const { sessionId } = await params;
  let detail: SessionTimelineDetail;
  try {
    detail = await cloudRequest<SessionTimelineDetail>(
      "/v1/internal/cloud/sessions/inspect",
      identity,
      { extraBody: { sessionId } },
    );
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) notFound();
    throw error;
  }

  const { session } = detail;
  return (
    <DashboardPage>
      <DashboardPageHeader
        title={session.title}
        action={
          <Button
            variant="outline"
            render={<a href={`/api/sessions/${session.id}/export`} />}
          >
            <DownloadIcon data-icon="inline-start" />
            Export
          </Button>
        }
      />
      <SessionDetail initial={detail} />
    </DashboardPage>
  );
}
