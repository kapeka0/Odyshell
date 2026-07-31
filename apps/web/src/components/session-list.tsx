"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { EllipsisIcon, EyeIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { CopyableValue } from "@/components/copyable-value";
import { DataTable, DataTableColumnHeader } from "@/components/data-table";
import { useDashboard } from "@/components/dashboard-provider";
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
import { Badge } from "@/components/ui/badge";
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
import type { CloudSession } from "@/lib/cloud-api";
import { TimerIcon } from "lucide-react";

export function SessionList({ sessions }: { sessions: CloudSession[] }) {
  const { refresh } = useDashboard();
  const columns = useMemo<ColumnDef<CloudSession>[]>(
    () => [
      {
        id: "search",
        accessorFn: (session) =>
          `${session.purpose} ${session.id} ${session.agentName ?? session.agentId}`,
      },
      {
        accessorKey: "purpose",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Purpose" />
        ),
        cell: ({ row }) => (
          <div className="min-w-0">
            <Link
              href={`/dashboard/sessions/${row.original.id}`}
              className="block truncate font-medium hover:underline"
            >
              {row.original.purpose}
            </Link>
            <CopyableValue
              value={row.original.id}
              label="Session ID"
              className="font-mono text-xs text-muted-foreground"
            />
          </div>
        ),
      },
      {
        id: "agent",
        accessorFn: (session) => session.agentName ?? session.agentId,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Agent" />
        ),
        cell: ({ row }) => row.original.agentName ?? row.original.agentId,
      },
      {
        accessorKey: "status",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => (
          <Badge variant={row.original.status === "active" ? "default" : "outline"}>
            {label(row.original.status)}
          </Badge>
        ),
        filterFn: "equals",
      },
      {
        accessorKey: "expiresAt",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Expires" />
        ),
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatTimestamp(row.original.expiresAt)}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <SessionActions session={row.original} refresh={refresh} />
        ),
      },
    ],
    [refresh],
  );

  if (sessions.length === 0) {
    return (
      <Empty className="min-h-64 rounded-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TimerIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No sessions yet</EmptyTitle>
          <EmptyDescription>
            Sessions appear after an Agent claims approved access.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={sessions}
      searchColumn="search"
      searchPlaceholder="Search sessions…"
      filter={{
        columnId: "status",
        label: "Status",
        options: [
          { label: "Active", value: "active" },
          { label: "Completed", value: "completed" },
          { label: "Cancelled", value: "cancelled" },
          { label: "Revoked", value: "revoked" },
          { label: "Expired", value: "expired" },
        ],
      }}
      emptyMessage="No sessions match these filters."
    />
  );
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

function label(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
