import { notFound, redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DownloadIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

  const { session, timeline } = detail;
  return (
    <DashboardPage>
      <DashboardPageHeader
        title={session.purpose}
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
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
            <CardDescription>{timeline.length} events</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {timeline.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="font-medium">
                      {eventLabel(event.eventType)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {event.source === "verified" ? "Verified" : "Agent"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestamp(event.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Session</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="flex flex-col gap-4 text-sm">
                <Detail label="Status">
                  <Badge variant={session.status === "active" ? "default" : "outline"}>
                    {eventLabel(session.status)}
                  </Badge>
                </Detail>
                <Detail label="Executor">
                  {session.agentName ?? session.agentId}
                </Detail>
                <Detail label="Expires">{formatTimestamp(session.expiresAt)}</Detail>
                <Detail label="Requester">
                  {session.requestedByAgentId ??
                    session.requestedByHumanId ??
                    "Workspace member"}
                </Detail>
                {session.runId ? <Detail label="Run">{session.runId}</Detail> : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Scopes</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {(session.scopes ?? []).map((scope) => (
                <div key={scope.machineId} className="flex flex-col gap-2 text-sm">
                  <p className="font-medium">
                    {session.targets.find(
                      (target) => target.machineId === scope.machineId,
                    )?.machineName ?? scope.machineId}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {scope.capabilities.map((capability) => (
                      <Badge key={capability} variant="outline">
                        {capability}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardPage>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words">{children}</dd>
    </div>
  );
}

function eventLabel(value: string): string {
  const label = value.replaceAll(".", " ").replaceAll("_", " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
