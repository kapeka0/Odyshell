"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { EllipsisIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { CopyableValue } from "@/components/copyable-value";
import {
  DataTable,
  DataTableColumnHeader,
} from "@/components/data-table";
import { AgentIdentityAvatar } from "@/components/identity-avatar";
import { useDashboard } from "@/components/dashboard-provider";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import type { CloudAgent } from "@/lib/cloud-api";

export function AgentList({
  agents,
  canDelete,
}: {
  agents: CloudAgent[];
  canDelete: boolean;
}) {
  const { refresh } = useDashboard();
  const columns = useMemo<ColumnDef<CloudAgent>[]>(
    () => [
      {
        id: "search",
        accessorFn: (agent) => `${agent.name} ${agent.id} ${agent.kind}`,
      },
      {
        accessorKey: "name",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Agent" />
        ),
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-3">
            <AgentIdentityAvatar
              name={row.original.name}
              className="size-8"
            />
            <div className="min-w-0">
              <p className="truncate font-medium">{row.original.name}</p>
              <CopyableValue
                value={row.original.id}
                label={`${row.original.name} ID`}
                className="font-mono text-xs text-muted-foreground"
              />
            </div>
          </div>
        ),
      },
      {
        accessorKey: "kind",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Type" />
        ),
        cell: ({ row }) => (
          <span className="capitalize">{row.original.kind}</span>
        ),
        filterFn: "equals",
      },
      {
        accessorKey: "status",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        filterFn: "equals",
      },
      {
        accessorKey: "parentAgentId",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Parent" />
        ),
        cell: ({ row }) =>
          row.original.parentAgentId ? (
            <CopyableValue
              value={row.original.parentAgentId}
              label="Parent ID"
              className="font-mono text-xs text-muted-foreground"
            />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Created" />
        ),
        cell: ({ row }) => (
          <time
            className="whitespace-nowrap text-muted-foreground"
            dateTime={row.original.createdAt}
          >
            {formatTimestamp(row.original.createdAt)}
          </time>
        ),
      },
      ...(canDelete
        ? [{
            id: "actions",
            enableSorting: false,
            header: () => <span className="sr-only">Actions</span>,
            cell: ({ row }: { row: { original: CloudAgent } }) => (
              <AgentActions agent={row.original} refresh={refresh} />
            ),
          } satisfies ColumnDef<CloudAgent>]
        : []),
    ],
    [canDelete, refresh],
  );

  return (
    <DataTable
      columns={columns}
      data={agents}
      searchColumn="search"
      searchPlaceholder="Search agents"
      emptyMessage="No Agents match these filters."
      filters={[
        {
          columnId: "kind",
          label: "Types",
          options: [
            { label: "Independent", value: "independent" },
            { label: "Managed", value: "managed" },
          ],
        },
        {
          columnId: "status",
          label: "Statuses",
          options: [
            { label: "Active", value: "active" },
            { label: "Disabled", value: "disabled" },
          ],
        },
      ]}
    />
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function AgentActions({
  agent,
  refresh,
}: {
  agent: CloudAgent;
  refresh: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function removeAgent() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${agent.id}`, {
        method: "DELETE",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Could not remove Agent");
      setOpen(false);
      toast.add({
        title: "Agent removed",
        description: `${agent.name} can no longer request Sessions.`,
        type: "success",
      });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove Agent");
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
              aria-label={`Actions for ${agent.name}`}
            />
          }
        >
          <EllipsisIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onClick={() => setOpen(true)}>
            <Trash2Icon aria-hidden="true" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {agent.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Credentials and active Sessions for this identity will be revoked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p className="text-sm text-destructive" role="alert">{error}</p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => void removeAgent()}
            >
              {pending ? <Spinner /> : null}
              {pending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
