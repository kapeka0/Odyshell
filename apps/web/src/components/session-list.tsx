"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { EllipsisIcon, EyeIcon, TimerIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { CopyableValue } from "@/components/copyable-value";
import { DataTable, DataTableColumnHeader } from "@/components/data-table";
import { useDashboard } from "@/components/dashboard-provider";
import { UserIdentityAvatar } from "@/components/identity-avatar";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import type {
  CloudMember,
  CloudSession,
  CloudSessionRequest,
} from "@/lib/cloud-api";

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
  const agents = useMemo(
    () =>
      new Map(
        (state.status === "ready" ? state.context.agents : []).map((agent) => [
          agent.id,
          agent.name,
        ]),
      ),
    [state],
  );
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
          `${row.value.purpose} ${row.value.agentName ?? "Agent"} ${requesterName(row.value, agents, members)}`,
      },
      {
        id: "purpose",
        accessorFn: (row) => row.value.purpose,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Purpose" />
        ),
        cell: ({ row }) => (
          <div className="w-56 max-w-56 min-w-0 xl:w-72 xl:max-w-72">
            {row.original.kind === "session" ? (
              <Link
                href={`/dashboard/sessions/${row.original.value.id}`}
                title={row.original.value.purpose}
                className="block truncate font-medium hover:underline"
              >
                {row.original.value.purpose}
              </Link>
            ) : row.original.value.status === "pending" &&
              row.original.value.approvalUrl ? (
              <Link
                href={row.original.value.approvalUrl}
                title={row.original.value.purpose}
                className="block truncate font-medium hover:underline"
              >
                {row.original.value.purpose}
              </Link>
            ) : (
              <span
                title={row.original.value.purpose}
                className="block truncate font-medium"
              >
                {row.original.value.purpose}
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
        id: "agent",
        accessorFn: (row) => row.value.agentName ?? "Agent",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Agent" />
        ),
        cell: ({ row }) => row.original.value.agentName ?? "Agent",
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

  if (rows.length === 0) {
    return (
      <Empty className="min-h-64 rounded-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TimerIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No sessions yet</EmptyTitle>
          <EmptyDescription>
            Requests appear here as soon as an Agent asks for access.
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
      emptyMessage="No sessions match these filters."
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
  agents: Map<string, string>;
  members: Map<string, CloudMember>;
}) {
  if (value.requestedByAgentId) {
    return <span>{agents.get(value.requestedByAgentId) ?? "Agent"}</span>;
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

function requesterName(
  value: CloudSession | CloudSessionRequest,
  agents: Map<string, string>,
  members: Map<string, CloudMember>,
): string {
  if (value.requestedByAgentId) {
    return agents.get(value.requestedByAgentId) ?? "Agent";
  }
  return (value.requestedByHumanId
    ? members.get(value.requestedByHumanId)?.name
    : undefined) ?? "Member";
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
