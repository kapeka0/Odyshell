"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { ActivityIcon, EllipsisIcon, EyeIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { CopyableValue } from "@/components/copyable-value";
import { useDashboard } from "@/components/dashboard-provider";
import {
  DataTable,
  DataTableColumnHeader,
} from "@/components/data-table";
import {
  AgentIdentityAvatar,
  UserIdentityAvatar,
} from "@/components/identity-avatar";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type {
  ControlAgent,
  ControlMachine,
  ControlMember,
  ControlEvent,
} from "@/lib/control-api";
import { formatDashboardTimestamp } from "@/lib/date-time";

type ActivityActor = {
  id: string;
  kind: "agent" | "member";
  name: string;
  imageUrl?: string;
};

type ActivityRow = ControlEvent & {
  actor: ActivityActor;
  target: string;
  label: string;
  result: "recorded" | "denied";
  type: string;
  search: string;
};

export function ControlEventList({
  events,
  machines,
  agents,
  members,
  retentionDays,
}: {
  events: ControlEvent[];
  machines: ControlMachine[];
  agents: ControlAgent[];
  members: ControlMember[];
  retentionDays: number;
}) {
  const { state } = useDashboard();
  const timeZone = state.status === "ready" ? state.context.userPreferences.timeZone : "System";
  const rows = useMemo(
    () => activityRows(events, machines, agents, members),
    [agents, events, machines, members],
  );
  const columns = useMemo<ColumnDef<ActivityRow>[]>(
    () => [
      {
        accessorKey: "search",
      },
      {
        accessorKey: "label",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Action" />
        ),
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.original.label}</p>
            <p className="truncate text-xs text-muted-foreground">
              {row.original.type}
            </p>
          </div>
        ),
      },
      {
        id: "actor",
        accessorFn: (row) => row.actor.name,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Actor" />
        ),
        cell: ({ row }) => <ActivityActorIdentity actor={row.original.actor} />,
      },
      {
        accessorKey: "target",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Target" />
        ),
        cell: ({ row }) => (
          <CopyableValue
            value={row.original.target}
            label="Target"
            className="text-muted-foreground"
          />
        ),
      },
      {
        accessorKey: "result",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Result" />
        ),
        cell: ({ row }) => <StatusBadge status={row.original.result} />,
        filterFn: "equals",
      },
      {
        accessorKey: "type",
        filterFn: "equals",
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Time" />
        ),
        cell: ({ row }) => (
          <time
            dateTime={row.original.createdAt ?? undefined}
            className="whitespace-nowrap font-mono text-xs text-muted-foreground"
          >
            {formatDashboardTimestamp(row.original.createdAt, timeZone)}
          </time>
        ),
        filterFn: (row, columnId, value) => {
          const timestamp = Date.parse(row.getValue<string>(columnId));
          const windows: Record<string, number> = {
            "24h": 24 * 60 * 60 * 1_000,
            "7d": 7 * 24 * 60 * 60 * 1_000,
            "30d": 30 * 24 * 60 * 60 * 1_000,
          };
          return Number.isFinite(timestamp) && Date.now() - timestamp <= windows[value]!;
        },
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => <ActivityActions event={row.original} timeZone={timeZone} />,
      },
    ],
    [timeZone],
  );

  if (events.length === 0) {
    return (
      <Empty className="min-h-64 rounded-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ActivityIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No activity yet</EmptyTitle>
          <EmptyDescription>
            Session, Command, enrollment, and identity events will appear here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchColumn="search"
      searchPlaceholder="Search activity…"
      filters={[
        {
          columnId: "result",
          label: "Results",
          options: [
            { label: "Recorded", value: "recorded" },
            { label: "Denied", value: "denied" },
          ],
        },
        {
          columnId: "type",
          label: "Types",
          options: [...new Set(rows.map((row) => row.type))].map((type) => ({
            label: type,
            value: type,
          })),
        },
        {
          columnId: "createdAt",
          label: "Dates",
          options: [
            { label: "Last 24 hours", value: "24h" },
            { label: "Last 7 days", value: "7d" },
            { label: "Last 30 days", value: "30d" },
          ],
        },
      ]}
      hiddenColumns={["search", "type"]}
      emptyMessage="No control events match these filters."
      summaryLabel={`${retentionDays} days retained`}
    />
  );
}

function ActivityActions({ event, timeZone }: { event: ActivityRow; timeZone: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${event.label}`}
            />
          }
        >
          <EllipsisIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setOpen(true)}>
            <EyeIcon aria-hidden="true" />
            View details
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{event.label}</DialogTitle>
            <DialogDescription>Control event details.</DialogDescription>
          </DialogHeader>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <Detail label="Actor">
              <ActivityActorIdentity actor={event.actor} />
            </Detail>
            <Detail label="Target">{event.target}</Detail>
            <Detail label="Result">
              {event.result === "denied" ? "Denied" : "Recorded"}
            </Detail>
            <Detail label="Time">{formatDashboardTimestamp(event.createdAt, timeZone)}</Detail>
            {event.metadata.reason ? (
              <Detail label="Reason">{event.metadata.reason}</Detail>
            ) : null}
            {event.metadata.command ? (
              <div className="sm:col-span-2">
                <Detail label="Command">
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs">
                    {event.metadata.command}
                  </pre>
                </Detail>
              </div>
            ) : null}
            {event.metadata.cwd ? (
              <Detail label="Working directory">{event.metadata.cwd}</Detail>
            ) : null}
            {event.metadata.timeoutSeconds ? (
              <Detail label="Timeout">{event.metadata.timeoutSeconds} seconds</Detail>
            ) : null}
            {event.metadata.exitCode !== undefined ? (
              <Detail label="Exit code">{event.metadata.exitCode ?? "Unavailable"}</Detail>
            ) : null}
            {event.metadata.outcome ? (
              <Detail label="Outcome">{event.metadata.outcome}</Detail>
            ) : null}
          </dl>
        </DialogContent>
      </Dialog>
    </>
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

function activityRows(
  events: ControlEvent[],
  machines: ControlMachine[],
  agents: ControlAgent[],
  members: ControlMember[],
): ActivityRow[] {
  const machineNames = new Map(
    machines.map((machine) => [machine.id, machine.name]),
  );
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const membersById = new Map(members.map((member) => [member.id, member]));
  return events.map((event) => {
    const actor = actorIdentity(event.principalId, agentsById, membersById);
    const target = targetLabel(event, machineNames, agentNames);
    const label = actionLabel(event.action);
    const type = event.action.split(".")[0] ?? "organization";
    return {
      ...event,
      actor,
      target,
      label,
      type,
      result:
        event.action.includes("denied") || event.action.includes("failed")
          ? "denied"
          : "recorded",
      search: `${label} ${actor.name} ${target} ${event.action}`,
    };
  });
}

function actorIdentity(
  principalId: string,
  agents: Map<string, ControlAgent>,
  members: Map<string, ControlMember>,
): ActivityActor {
  const agent = agents.get(principalId);
  if (agent) {
    return { id: agent.id, kind: "agent", name: agent.name };
  }
  const member = members.get(principalId);
  return {
    id: principalId,
    kind: "member",
    name: member?.name ?? "Member",
    ...(member?.imageUrl ? { imageUrl: member.imageUrl } : {}),
  };
}

function ActivityActorIdentity({ actor }: { actor: ActivityActor }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {actor.kind === "agent" ? (
        <AgentIdentityAvatar name={actor.name} className="size-6" />
      ) : (
        <UserIdentityAvatar
          identity={actor.id}
          imageUrl={actor.imageUrl}
          name={actor.name}
          className="size-6"
        />
      )}
      <span className="truncate">{actor.name}</span>
    </span>
  );
}

function targetLabel(
  event: ControlEvent,
  machineNames: Map<string, string>,
  agentNames: Map<string, string>,
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
  if (event.targetType === "agent") {
    return agentNames.get(event.targetId) ?? "Removed Agent";
  }
  if (event.targetType === "session") return `Session ${event.targetId}`;
  if (event.targetType === "command") return `Command ${event.targetId}`;
  return "Organization";
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    "agent.deleted": "Agent removed",
    "machine.enrolled": "Machine enrolled",
    "machine.revoked": "Machine removed",
    "machine.ping": "Machine reached",
    "machine.ping_denied": "Machine reachability denied",
    "session.requested": "Session requested",
    "session.opened": "Session opened",
    "session.open_failed": "Session opening failed",
    "session.approved": "Session approved",
    "session.denied": "Session denied",
    "session.closed": "Session closed",
    "command.created": "Command requested",
    "command.completed": "Command completed",
    "enrollment_token.created": "Enrollment command created",
    "cli.login_approved": "CLI login approved",
  };
  return labels[action] ?? "Control event";
}
