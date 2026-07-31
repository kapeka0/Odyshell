"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { ActivityIcon, EllipsisIcon, EyeIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { CopyableValue } from "@/components/copyable-value";
import {
  DataTable,
  DataTableColumnHeader,
} from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
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
  CloudAgent,
  CloudMachine,
  ControlEvent,
} from "@/lib/cloud-api";

type ActivityRow = ControlEvent & {
  actor: string;
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
  retentionDays,
}: {
  events: ControlEvent[];
  machines: CloudMachine[];
  agents: CloudAgent[];
  retentionDays: number;
}) {
  const rows = useMemo(
    () => activityRows(events, machines, agents),
    [agents, events, machines],
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
        accessorKey: "actor",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Actor" />
        ),
        cell: ({ row }) => (
          <CopyableValue
            value={row.original.actor}
            label="Actor"
            className="text-muted-foreground"
          />
        ),
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
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.result === "denied" ? "destructive" : "outline"
            }
          >
            {row.original.result === "denied" ? "Denied" : "Recorded"}
          </Badge>
        ),
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
            {formatTimestamp(row.original.createdAt)}
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
        cell: ({ row }) => <ActivityActions event={row.original} />,
      },
    ],
    [],
  );

  if (events.length === 0) {
    return (
      <Empty className="min-h-64 rounded-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ActivityIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No control events yet</EmptyTitle>
          <EmptyDescription>
            Enrollment and access changes will appear here.
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

function ActivityActions({ event }: { event: ActivityRow }) {
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
            <Detail label="Actor">{event.actor}</Detail>
            <Detail label="Target">{event.target}</Detail>
            <Detail label="Result">
              {event.result === "denied" ? "Denied" : "Recorded"}
            </Detail>
            <Detail label="Time">{formatTimestamp(event.createdAt)}</Detail>
            {event.metadata.kind ? (
              <Detail label="Capability">{event.metadata.kind}</Detail>
            ) : null}
            {event.metadata.reason ? (
              <Detail label="Reason">{event.metadata.reason}</Detail>
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
  machines: CloudMachine[],
  agents: CloudAgent[],
): ActivityRow[] {
  const machineNames = new Map(
    machines.map((machine) => [machine.id, machine.name]),
  );
  const accessNames = new Map(
    agents.map((agent) => [agent.id, agent.name]),
  );
  return events.map((event) => {
    const actor = actorLabel(event.principalId, accessNames);
    const target = targetLabel(event, machineNames, accessNames);
    const label = actionLabel(event.action);
    const type = event.action.split(".")[0] ?? "workspace";
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
      search: `${label} ${actor} ${target} ${event.action}`,
    };
  });
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
    return accessNames.get(event.targetId) ?? "Removed agent";
  }
  if (event.targetType === "session") return "Temporary session";
  if (event.targetType === "operation") return "Machine operation";
  return "Workspace";
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    "agent_token.created": "Agent created",
    "agent_token.revoked": "Agent revoked",
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
