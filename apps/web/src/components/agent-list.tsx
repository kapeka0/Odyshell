"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { EllipsisIcon, ShieldCheckIcon, ShieldOffIcon, Trash2Icon } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import type { CloudAgent } from "@/lib/cloud-api";
import { formatDashboardTimestamp } from "@/lib/date-time";

export function AgentList({
  agents,
  canManage,
}: {
  agents: CloudAgent[];
  canManage: boolean;
}) {
  const { refresh, state } = useDashboard();
  const timeZone = state.status === "ready" ? state.context.userPreferences.timeZone : "System";
  const columns = useMemo<ColumnDef<CloudAgent>[]>(
    () => [
      {
        id: "search",
        accessorFn: (agent) => `${agent.name} ${agent.id} ${agent.role}`,
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
        accessorKey: "role",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Role" />
        ),
        cell: ({ row }) => (
          <Badge variant={row.original.role === "operator" ? "secondary" : "outline"}>
            {row.original.role === "operator" ? "Operator" : "Standard"}
          </Badge>
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
        accessorKey: "createdAt",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Created" />
        ),
        cell: ({ row }) => (
          <time
            className="whitespace-nowrap text-muted-foreground"
            dateTime={row.original.createdAt}
          >
            {formatDashboardTimestamp(row.original.createdAt, timeZone)}
          </time>
        ),
      },
      ...(canManage
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
    [canManage, refresh, timeZone],
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
          columnId: "role",
          label: "Roles",
          options: [
            { label: "Standard", value: "standard" },
            { label: "Operator", value: "operator" },
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

function AgentActions({
  agent,
  refresh,
}: {
  agent: CloudAgent;
  refresh: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);
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

  async function changeRole() {
    const nextRole = agent.role === "operator" ? "standard" : "operator";
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not change Agent role");
      setRoleOpen(false);
      toast.add({
        title: nextRole === "operator" ? "Operator access granted" : "Approval required",
        description: nextRole === "operator"
          ? `${agent.name} can now open Sessions without Human approval.`
          : `${agent.name} now needs Human approval for every Session.`,
        type: "success",
      });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not change Agent role");
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
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setRoleOpen(true)}>
              {agent.role === "operator" ? (
                <ShieldOffIcon aria-hidden="true" />
              ) : (
                <ShieldCheckIcon aria-hidden="true" />
              )}
              {agent.role === "operator" ? "Require approval" : "Make Operator"}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onClick={() => setOpen(true)}>
              <Trash2Icon aria-hidden="true" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuGroup>
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

      <AlertDialog open={roleOpen} onOpenChange={setRoleOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {agent.role === "operator" ? "Require approval?" : `Make ${agent.name} an Operator?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {agent.role === "operator"
                ? "Active Sessions will be revoked. Future Sessions require explicit Human approval."
                : "This Agent will be able to open temporary shell Sessions on Organization Machines without explicit Human approval."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={() => void changeRole()}>
              {pending ? <Spinner /> : null}
              {agent.role === "operator" ? "Require approval" : "Grant Operator"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
