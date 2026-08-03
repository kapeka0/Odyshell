"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { EllipsisIcon, EyeIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { CopyableValue } from "@/components/copyable-value";
import { CreateSessionSheet } from "@/components/create-session-sheet";
import { DataTable, DataTableColumnHeader } from "@/components/data-table";
import { useDashboard } from "@/components/dashboard-provider";
import {
  AgentIdentityAvatar,
  UserIdentityAvatar,
} from "@/components/identity-avatar";
import { StatusBadge } from "@/components/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import type {
  CloudAgent,
  CloudMember,
  CloudSession,
  CloudSessionRequest,
} from "@/lib/cloud-api";
import { formatSessionDuration } from "@/lib/session-time";

type SessionRow =
  | { kind: "session"; value: CloudSession }
  | { kind: "request"; value: CloudSessionRequest };

export function SessionList({
  sessions,
  requests,
}: {
  sessions: CloudSession[];
  requests: CloudSessionRequest[];
}) {
  const { refresh, state } = useDashboard();
  const members = useMemo(
    () =>
      new Map(
        (state.status === "ready" ? state.context.members : []).map((member) => [
          member.id,
          member,
        ]),
      ),
    [state],
  );
  const agents = useMemo(
    () =>
      new Map(
        (state.status === "ready" ? state.context.agents : []).map((agent) => [
          agent.id,
          agent,
        ]),
      ),
    [state],
  );
  const rows = useMemo<SessionRow[]>(
    () =>
      [
        ...requests.map((value) => ({ kind: "request" as const, value })),
        ...sessions.map((value) => ({ kind: "session" as const, value })),
      ].sort(
        (left, right) =>
          new Date(right.value.createdAt).getTime() -
          new Date(left.value.createdAt).getTime(),
      ),
    [requests, sessions],
  );
  const columns = useMemo<ColumnDef<SessionRow>[]>(
    () => [
      {
        id: "search",
        accessorFn: (row) =>
          `${row.value.title} ${row.value.purpose} ${row.value.agentName ?? "Agent"} ${requesterName(row.value, agents, members)} ${machineLabel(row)}`,
      },
      {
        id: "title",
        accessorFn: (row) => row.value.title,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Title" />
        ),
        cell: ({ row }) => (
          <div className="w-56 max-w-56 min-w-0 xl:w-72 xl:max-w-72">
            {row.original.kind === "session" ? (
              <Link
                href={`/dashboard/sessions/${row.original.value.id}`}
                title={row.original.value.title}
                className="block truncate font-medium hover:underline"
              >
                {row.original.value.title}
              </Link>
            ) : row.original.value.status === "pending" &&
              row.original.value.approvalUrl ? (
              <Link
                href={row.original.value.approvalUrl}
                title={row.original.value.title}
                className="block truncate font-medium hover:underline"
              >
                {row.original.value.title}
              </Link>
            ) : (
              <span
                title={row.original.value.title}
                className="block truncate font-medium"
              >
                {row.original.value.title}
              </span>
            )}
            <CopyableValue
              value={row.original.value.id}
              label={row.original.kind === "session" ? "Session ID" : "Request ID"}
              className="font-mono text-xs text-muted-foreground"
            />
          </div>
        ),
      },
      {
        id: "machine",
        accessorFn: machineLabel,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Machine" />
        ),
        cell: ({ row }) => {
          const machines = row.original.kind === "session"
            ? row.original.value.targets.map((target) => target.machineName)
            : row.original.value.machines.map((machine) => machine.name);
          return (
            <span className="whitespace-nowrap">
              {machines[0] ?? "Unavailable"}
              {machines.length > 1 ? (
                <span className="ml-1 text-muted-foreground">+{machines.length - 1}</span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "agent",
        accessorFn: (row) => row.value.agentName ?? "Agent",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Agent" />
        ),
        cell: ({ row }) => {
          const name = row.original.value.agentName ?? "Agent";
          return (
            <span className="flex items-center gap-2">
              <AgentIdentityAvatar name={name} className="size-6" />
              <span className="truncate">{name}</span>
            </span>
          );
        },
      },
      {
        id: "requester",
        accessorFn: (row) => requesterName(row.value, agents, members),
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Requester" />
        ),
        cell: ({ row }) => (
          <Requester
            value={row.original.value}
            agents={agents}
            members={members}
          />
        ),
      },
      {
        id: "status",
        accessorFn: (row) => row.value.status,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => <StatusBadge status={row.original.value.status} />,
        filterFn: "equals",
      },
      {
        id: "duration",
        accessorFn: sessionDurationSeconds,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Duration" />
        ),
        cell: ({ row }) => (
          <span className="whitespace-nowrap tabular-nums text-muted-foreground">
            {formatSessionDuration(sessionDurationSeconds(row.original))}
          </span>
        ),
      },
      {
        id: "expiresAt",
        accessorFn: (row) => row.value.expiresAt,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Expires" />
        ),
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatTimestamp(row.original.value.expiresAt)}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) =>
          row.original.kind === "session" ? (
            <SessionActions session={row.original.value} refresh={refresh} />
          ) : (
            <RequestActions request={row.original.value} />
          ),
      },
    ],
    [agents, members, refresh],
  );

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchColumn="search"
      searchPlaceholder="Search sessions…"
      filter={{
        columnId: "status",
        label: "Status",
        options: [
          { label: "Pending", value: "pending" },
          { label: "Approved", value: "approved" },
          { label: "Active", value: "active" },
          { label: "Completed", value: "completed" },
          { label: "Cancelled", value: "cancelled" },
          { label: "Revoked", value: "revoked" },
          { label: "Denied", value: "denied" },
          { label: "Expired", value: "expired" },
        ],
      }}
      emptyMessage={rows.length === 0 ? "No sessions yet." : "No sessions match these filters."}
      toolbarAction={<CreateSessionSheet />}
    />
  );
}

function RequestActions({ request }: { request: CloudSessionRequest }) {
  if (request.status !== "pending" || !request.approvalUrl) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${request.purpose}`}
          />
        }
      >
        <EllipsisIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem render={<Link href={request.approvalUrl} />}>
          <EyeIcon aria-hidden="true" />
          Review
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Requester({
  value,
  agents,
  members,
}: {
  value: CloudSession | CloudSessionRequest;
  agents: Map<string, CloudAgent>;
  members: Map<string, CloudMember>;
}) {
  const agent = value.requestedByAgentId
    ? agents.get(value.requestedByAgentId)
    : undefined;
  if (value.requestedByAgentId) {
    const name = agent?.name ?? "Agent";
    return (
      <span className="flex items-center gap-2">
        <AgentIdentityAvatar name={name} className="size-6" />
        <span className="truncate">{name}</span>
      </span>
    );
  }
  const humanId = value.requestedByHumanId;
  const member = humanId ? members.get(humanId) : undefined;
  const name = member?.name ?? "Member";
  return (
    <span className="flex items-center gap-2">
      <UserIdentityAvatar
        identity={humanId ?? "member"}
        imageUrl={member?.imageUrl}
        name={name}
        className="size-6"
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

function sessionDurationSeconds(row: SessionRow): number {
  if (row.kind === "request") return row.value.durationSeconds;
  return Math.max(
    0,
    (new Date(row.value.expiresAt).getTime() -
      new Date(row.value.readyAt ?? row.value.createdAt).getTime()) /
      1_000,
  );
}

function requesterName(
  value: CloudSession | CloudSessionRequest,
  agents: Map<string, CloudAgent>,
  members: Map<string, CloudMember>,
): string {
  if (value.requestedByAgentId) {
    return agents.get(value.requestedByAgentId)?.name ?? "Agent";
  }
  return (value.requestedByHumanId
    ? members.get(value.requestedByHumanId)?.name
    : undefined) ?? "Member";
}

function machineLabel(row: SessionRow): string {
  const machines = row.kind === "session"
    ? row.value.targets.map((target) => target.machineName)
    : row.value.machines.map((machine) => machine.name);
  return machines.join(" ");
}

function SessionActions({
  session,
  refresh,
}: {
  session: CloudSession;
  refresh: () => Promise<unknown>;
}) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function cancelSession() {
    setPending(true);
    try {
      const response = await fetch(`/api/sessions/${session.id}`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Could not cancel session");
      setCancelOpen(false);
      toast.add({ title: "Session cancelled", type: "success" });
      await refresh();
    } catch (error) {
      toast.add({
        title: "Session not cancelled",
        description: error instanceof Error ? error.message : "Try again.",
        type: "error",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${session.purpose}`}
            />
          }
        >
          <EllipsisIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            render={<Link href={`/dashboard/sessions/${session.id}`} />}
          >
            <EyeIcon aria-hidden="true" />
            View
          </DropdownMenuItem>
          {session.status === "active" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setCancelOpen(true)}
              >
                <XIcon aria-hidden="true" />
                Cancel
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel session?</AlertDialogTitle>
            <AlertDialogDescription>
              Active operations stop and the credential cannot be used again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Back</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => void cancelSession()}
            >
              {pending ? <Spinner /> : null}
              Cancel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
