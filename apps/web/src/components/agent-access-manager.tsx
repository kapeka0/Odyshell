"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { EllipsisIcon, EyeIcon, KeyRoundIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { CopyableValue } from "@/components/copyable-value";
import {
  DataTable,
  DataTableColumnHeader,
} from "@/components/data-table";
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
import type { AgentAccess, CloudMachine } from "@/lib/cloud-api";

export function AgentAccessManager({
  machines,
  accesses,
}: {
  machines: CloudMachine[];
  accesses: AgentAccess[];
}) {
  const { refresh } = useDashboard();
  const machineNames = useMemo(
    () => new Map(machines.map((machine) => [machine.id, machine.name])),
    [machines],
  );
  const columns = useMemo<ColumnDef<AgentAccess>[]>(
    () => [
      {
        id: "search",
        accessorFn: (access) => access.name,
      },
      {
        accessorKey: "name",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Agent" />
        ),
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.original.name}</p>
            <CopyableValue
              value={row.original.id}
              label={`${row.original.name} ID`}
              className="font-mono text-xs text-muted-foreground"
            />
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => (
          <Badge variant={statusVariant(row.original.status)}>
            {row.original.status}
          </Badge>
        ),
        filterFn: "equals",
      },
      {
        id: "machines",
        accessorFn: (access) => access.machineIds.length,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Machines" />
        ),
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.machineIds
              .map((id) => machineNames.get(id) ?? "Removed machine")
              .join(", ")}
          </span>
        ),
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
          <AccessActions
            access={row.original}
            machineNames={machineNames}
            refresh={refresh}
          />
        ),
      },
    ],
    [machineNames, refresh],
  );

  if (accesses.length === 0) {
    return (
      <Empty className="min-h-64 rounded-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <KeyRoundIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No agents yet</EmptyTitle>
          <EmptyDescription>
            Create scoped access when an agent needs a machine.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={accesses}
      searchColumn="search"
      searchPlaceholder="Search agents…"
      filter={{
        columnId: "status",
        label: "Statuses",
        options: [
          { label: "Active", value: "active" },
          { label: "Expired", value: "expired" },
          { label: "Revoked", value: "revoked" },
        ],
      }}
      emptyMessage="No agents match these filters."
    />
  );
}

function AccessActions({
  access,
  machineNames,
  refresh,
}: {
  access: AgentAccess;
  machineNames: Map<string, string>;
  refresh: () => Promise<unknown>;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revokeAccess() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/agent-access/${access.id}`, {
        method: "DELETE",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? "Could not revoke agent access");
      }
      setRevokeOpen(false);
      toast.add({
        title: "Agent access revoked",
        description: `${access.name} can no longer create sessions.`,
        type: "success",
      });
      await refresh();
    } catch (reason) {
      toast.add({
        title: "Agent access was not revoked",
        description: "The existing credential remains unchanged.",
        type: "error",
      });
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not revoke agent access",
      );
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
              aria-label={`Actions for ${access.name}`}
              disabled={pending}
            />
          }
        >
          {pending ? <Spinner /> : <EllipsisIcon aria-hidden="true" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setDetailsOpen(true)}>
            <EyeIcon aria-hidden="true" />
            View details
          </DropdownMenuItem>
          {access.status === "active" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setRevokeOpen(true)}
              >
                Revoke
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{access.name}</DialogTitle>
            <DialogDescription>
              Temporary authorization details. The credential is never shown
              again.
            </DialogDescription>
          </DialogHeader>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <Detail label="Status">
              <Badge variant={statusVariant(access.status)}>
                {access.status}
              </Badge>
            </Detail>
            <Detail label="Expires">{formatTimestamp(access.expiresAt)}</Detail>
            <Detail label="Machines" wide>
              {access.machineIds
                .map((id) => machineNames.get(id) ?? "Removed machine")
                .join(", ")}
            </Detail>
            <Detail label="Capabilities" wide>
              <span className="flex flex-wrap gap-1.5">
                {access.capabilities.map((capability) => (
                  <Badge key={capability} variant="outline">
                    {capability}
                  </Badge>
                ))}
              </span>
            </Detail>
          </dl>
        </DialogContent>
      </Dialog>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {access.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The credential stops working immediately and active sessions
              close. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void revokeAccess()}
              disabled={pending}
            >
              {pending ? <Spinner /> : null}
              {pending ? "Revoking…" : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Detail({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

function statusVariant(
  status: AgentAccess["status"],
): "default" | "outline" | "destructive" {
  if (status === "active") return "default";
  if (status === "revoked") return "destructive";
  return "outline";
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
