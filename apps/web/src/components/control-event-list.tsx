import { ActivityIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type {
  AgentAccess,
  CloudMachine,
  ControlEvent,
} from "@/lib/cloud-api";

export function ControlEventList({
  events,
  machines,
  accesses,
}: {
  events: ControlEvent[];
  machines: CloudMachine[];
  accesses: AgentAccess[];
}) {
  const machineNames = new Map(
    machines.map((machine) => [machine.id, machine.name]),
  );
  const accessNames = new Map(
    accesses.map((access) => [access.id, access.name]),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Control Events</CardTitle>
        <CardDescription>
          Security-relevant access changes without commands, paths, file
          contents or operation output.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">Privacy-minimal</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <Empty className="min-h-40 border-y">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ActivityIcon />
              </EmptyMedia>
              <EmptyTitle>No control events yet</EmptyTitle>
              <EmptyDescription>
                Enrollment and access changes will appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="divide-y">
            {events.map((event) => (
              <div
                key={event.id}
                className="grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
              >
                <div>
                  <p className="font-heading font-medium">
                    {actionLabel(event.action)}
                  </p>
                  <p className="mt-1 break-all text-sm text-muted-foreground">
                    {actorLabel(event.principalId, accessNames)}
                    {" · "}
                    {targetLabel(event, machineNames, accessNames)}
                  </p>
                  {event.metadata.kind || event.metadata.reason ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {[event.metadata.kind, event.metadata.reason]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  ) : null}
                </div>
                <time className="font-mono text-xs text-muted-foreground">
                  {formatTimestamp(event.createdAt)}
                </time>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function actorLabel(
  principalId: string,
  accessNames: Map<string, string>,
): string {
  const accessName = accessNames.get(principalId);
  return accessName ? `Agent ${accessName}` : `Member ${principalId}`;
}

function targetLabel(
  event: ControlEvent,
  machineNames: Map<string, string>,
  accessNames: Map<string, string>,
): string {
  if (event.metadata.machineId) {
    return (
      machineNames.get(event.metadata.machineId) ??
      `Machine ${event.metadata.machineId}`
    );
  }
  if (event.targetType === "machine") {
    return machineNames.get(event.targetId) ?? "Removed machine";
  }
  if (event.targetType === "agent_token") {
    return accessNames.get(event.targetId) ?? "Removed Agent Access";
  }
  if (event.targetType === "session") return "Temporary session";
  if (event.targetType === "operation") return "Machine operation";
  return "Workspace";
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    "agent_token.created": "Agent Access created",
    "agent_token.revoked": "Agent Access revoked",
    "machine.enrolled": "Machine enrolled",
    "machine.revoked": "Machine removed",
    "machine.ping": "Machine reached",
    "machine.ping_denied": "Machine reachability denied",
    "session.created": "Session opened",
    "session.denied": "Session denied",
    "session.close_requested": "Session close requested",
    "operation.created": "Operation requested",
    "operation.denied": "Operation denied",
    "operation.cancel_requested": "Operation cancellation requested",
    "operation.completed": "Operation completed",
    "enrollment_token.created": "Enrollment command created",
    "cli.login_approved": "CLI login approved",
  };
  return labels[action] ?? "Control event";
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Unknown time";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
