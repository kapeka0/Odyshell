"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  CpuIcon,
  EllipsisIcon,
  EyeIcon,
  RadioIcon,
  Trash2Icon,
} from "lucide-react";
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
import type { CloudMachine } from "@/lib/cloud-api";

export function MachineList({ machines }: { machines: CloudMachine[] }) {
  const { refresh } = useDashboard();
  const columns = useMemo<ColumnDef<CloudMachine>[]>(
    () => [
      {
        id: "search",
        accessorFn: (machine) => `${machine.name} ${machine.id}`,
        enableHiding: true,
      },
      {
        accessorKey: "name",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Machine" />
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
        id: "connection",
        accessorFn: (machine) => (machine.online ? "online" : "offline"),
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-2">
            <span
              className={
                row.original.online
                  ? "size-2 rounded-full bg-emerald-500 motion-safe:animate-pulse"
                  : "size-2 rounded-full bg-muted-foreground/45"
              }
              aria-hidden="true"
            />
            {row.original.online ? "Online" : "Offline"}
          </span>
        ),
        filterFn: "equals",
      },
      {
        accessorKey: "lastSeenAt",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Last seen" />
        ),
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatTimestamp(row.original.lastSeenAt)}
          </span>
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <MachineActions machine={row.original} refresh={refresh} />
        ),
      },
    ],
    [refresh],
  );

  if (machines.length === 0) {
    return (
      <Empty className="min-h-64 rounded-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CpuIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No machines yet</EmptyTitle>
          <EmptyDescription>
            Use Add machine to create a one-time connection command.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={machines}
      searchColumn="search"
      searchPlaceholder="Search machines…"
      filter={{
        columnId: "connection",
        label: "Status",
        options: [
          { label: "Online", value: "online" },
          { label: "Offline", value: "offline" },
        ],
      }}
      emptyMessage="No machines match these filters."
    />
  );
}

function MachineActions({
  machine,
  refresh,
}: {
  machine: CloudMachine;
  refresh: () => Promise<unknown>;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    "ping" | "remove" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  async function pingMachine() {
    setPendingAction("ping");
    try {
      const response = await fetch(`/api/machines/${machine.id}/ping`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        latencyMs?: number;
      };
      if (!response.ok) throw new Error(body.error ?? "Ping failed");
      toast.add({
        title: "Pong! 🏓",
        description: `${machine.name} replied in ${body.latencyMs ?? 0} ms.`,
        type: "success",
      });
      await refresh();
    } catch (reason) {
      toast.add({
        title: "Machine did not reply",
        description:
          reason instanceof Error ? reason.message : "The ping failed.",
        type: "error",
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function removeMachine() {
    setPendingAction("remove");
    setError(null);
    try {
      const response = await fetch(`/api/machines/${machine.id}`, {
        method: "DELETE",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? "Could not remove machine");
      }
      setRemoveOpen(false);
      toast.add({
        title: "Machine removed",
        description: `${machine.name} can no longer receive operations.`,
        type: "success",
      });
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not remove machine",
      );
      toast.add({
        title: "Machine was not removed",
        description: `${machine.name} remains enrolled.`,
        type: "error",
      });
    } finally {
      setPendingAction(null);
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
              aria-label={`Actions for ${machine.name}`}
              disabled={pendingAction !== null}
            />
          }
        >
          {pendingAction ? <Spinner /> : <EllipsisIcon aria-hidden="true" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setDetailsOpen(true)}>
            <EyeIcon aria-hidden="true" />
            View details
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!machine.online}
            onClick={() => void pingMachine()}
          >
            <RadioIcon aria-hidden="true" />
            Ping
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setRemoveOpen(true)}
          >
            <Trash2Icon aria-hidden="true" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{machine.name}</DialogTitle>
            <DialogDescription>
              Enrollment and presence details for this machine.
            </DialogDescription>
          </DialogHeader>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <Detail label="Status">
              <Badge variant={machine.online ? "default" : "outline"}>
                {machine.online ? "Online" : "Offline"}
              </Badge>
            </Detail>
            <Detail label="Last seen">
              {formatTimestamp(machine.lastSeenAt)}
            </Detail>
            <Detail label="Enrolled">
              {formatTimestamp(machine.enrolledAt)}
            </Detail>
            <Detail label="Machine ID">
              <span className="break-all font-mono text-xs">{machine.id}</span>
            </Detail>
          </dl>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {machine.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The Client will disconnect and active operations will be
              cancelled. Reconnecting it later requires a new enrollment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingAction === "remove"}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void removeMachine()}
              disabled={pendingAction === "remove"}
            >
              {pendingAction === "remove" ? <Spinner /> : null}
              {pendingAction === "remove" ? "Removing…" : "Remove machine"}
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
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
