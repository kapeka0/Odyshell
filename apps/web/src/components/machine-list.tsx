"use client";

import type { Capability } from "@odyshell/protocol";
import type { ColumnDef } from "@tanstack/react-table";
import {
  EllipsisIcon,
  EyeIcon,
  PencilIcon,
  PlusIcon,
  RadioIcon,
  Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { CopyableValue } from "@/components/copyable-value";
import {
  DataTable,
  DataTableColumnHeader,
} from "@/components/data-table";
import { useDashboard } from "@/components/dashboard-provider";
import { StatusBadge } from "@/components/status-badge";
import { StatusDot } from "@/components/status-dot";
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
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { capabilityGroups } from "@/lib/agent-access-options";
import type { CloudMachine } from "@/lib/cloud-api";
import { machinePlatform } from "@/lib/machine-platform";

export function MachineList({
  machines,
  atLimit,
}: {
  machines: CloudMachine[];
  atLimit: boolean;
}) {
  const { refresh, optimisticallyUpdate } = useDashboard();
  const columns = useMemo<ColumnDef<CloudMachine>[]>(
    () => [
      {
        id: "search",
        accessorFn: (machine) =>
          `${machine.name} ${machine.description ?? ""} ${machine.id} ${machinePlatform(machine.runtime)}`,
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
            {row.original.description ? (
              <p className="max-w-72 truncate text-xs text-muted-foreground">
                {row.original.description}
              </p>
            ) : null}
            <CopyableValue
              value={row.original.id}
              label={`${row.original.name} ID`}
              className="font-mono text-xs text-muted-foreground"
            />
          </div>
        ),
      },
      {
        id: "platform",
        accessorFn: (machine) => machinePlatform(machine.runtime),
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Platform" />
        ),
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {machinePlatform(row.original.runtime)}
          </span>
        ),
      },
      {
        id: "connection",
        accessorFn: (machine) => (machine.online ? "online" : "offline"),
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => (
          <StatusBadge status={row.original.online ? "online" : "offline"}>
            <StatusDot active={row.original.online} />
            {row.original.online ? "Online" : "Offline"}
          </StatusBadge>
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
          <MachineActions
            machine={row.original}
            refresh={refresh}
            onUpdated={(updated) =>
              optimisticallyUpdate((context) => ({
                ...context,
                machines: context.machines.map((machine) =>
                  machine.id === updated.id ? updated : machine,
                ),
              }))
            }
          />
        ),
      },
    ],
    [optimisticallyUpdate, refresh],
  );

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
      emptyMessage={
        machines.length === 0
          ? "No machines yet."
          : "No machines match these filters."
      }
      toolbarAction={
        <div className="flex flex-col items-end gap-1">
          {atLimit ? (
            <Button type="button" disabled>
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              Add
            </Button>
          ) : (
            <Link
              href="/dashboard/machines/add"
              className={buttonVariants()}
            >
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              Add
            </Link>
          )}
          {atLimit ? (
            <p className="text-xs text-destructive">Machine limit reached</p>
          ) : null}
        </div>
      }
    />
  );
}

function MachineActions({
  machine,
  refresh,
  onUpdated,
}: {
  machine: CloudMachine;
  refresh: () => Promise<unknown>;
  onUpdated: (machine: CloudMachine) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    "ping" | "save" | "remove" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(machine.name);
  const [description, setDescription] = useState(machine.description ?? "");
  const [capabilities, setCapabilities] = useState<Capability[]>(
    machine.capabilities,
  );

  function openEdit() {
    setName(machine.name);
    setDescription(machine.description ?? "");
    setCapabilities(machine.capabilities);
    setError(null);
    setEditOpen(true);
  }

  async function saveMachine(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setPendingAction("save");
    setError(null);
    const optimistic = {
      ...machine,
      name: name.trim(),
      description: description.trim() || null,
      capabilities,
    };
    onUpdated(optimistic);
    try {
      const response = await fetch(`/api/machines/${machine.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description, capabilities }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        name?: string;
        description?: string | null;
        capabilities?: Capability[];
        availableCapabilities?: Capability[];
      };
      if (!response.ok) throw new Error(body.error ?? "Could not save machine");
      onUpdated({
        ...optimistic,
        name: body.name ?? optimistic.name,
        description: body.description ?? null,
        capabilities: body.capabilities ?? optimistic.capabilities,
        availableCapabilities:
          body.availableCapabilities ?? machine.availableCapabilities,
      });
      setEditOpen(false);
      toast.add({ title: "Machine saved", type: "success" });
      await refresh();
    } catch (reason) {
      onUpdated(machine);
      const message =
        reason instanceof Error ? reason.message : "Could not save machine";
      setError(message);
      toast.add({
        title: "Machine not saved",
        description: message,
        type: "error",
      });
    } finally {
      setPendingAction(null);
    }
  }

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
          <DropdownMenuItem onClick={openEdit}>
            <PencilIcon aria-hidden="true" />
            Edit
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
              <StatusBadge status={machine.online ? "online" : "offline"}>
                <StatusDot active={machine.online} />
                {machine.online ? "Online" : "Offline"}
              </StatusBadge>
            </Detail>
            <Detail label="Last seen">
              {formatTimestamp(machine.lastSeenAt)}
            </Detail>
            <Detail label="Platform">
              {machinePlatform(machine.runtime)}
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

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit machine</DialogTitle>
            <DialogDescription>
              Metadata helps Agents choose the right machine. Capabilities can
              only reduce the Client Local Policy.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveMachine}>
            <FieldGroup className="max-h-[60svh] overflow-y-auto pr-1">
              <Field>
                <FieldLabel htmlFor={`machine-name-${machine.id}`}>
                  Name
                </FieldLabel>
                <Input
                  id={`machine-name-${machine.id}`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={128}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`machine-description-${machine.id}`}>
                  Description
                </FieldLabel>
                <Textarea
                  id={`machine-description-${machine.id}`}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={280}
                  placeholder="Home server for media and backups"
                />
              </Field>
              <Field>
                <FieldLabel>Capabilities</FieldLabel>
                <div className="rounded-lg border p-3">
                  {capabilityGroups
                    .flatMap((group) => group.capabilities)
                    .map((capability) => {
                      const available =
                        machine.availableCapabilities.includes(
                          capability.value,
                        );
                      return (
                        <Field
                          key={capability.value}
                          orientation="horizontal"
                          className="py-1.5"
                        >
                          <Checkbox
                            id={`machine-${machine.id}-${capability.value}`}
                            checked={capabilities.includes(capability.value)}
                            disabled={!available}
                            onCheckedChange={(checked) =>
                              setCapabilities((current) =>
                                checked
                                  ? [...new Set([...current, capability.value])]
                                  : current.filter(
                                      (value) => value !== capability.value,
                                    ),
                              )
                            }
                          />
                          <FieldContent>
                            <FieldLabel
                              htmlFor={`machine-${machine.id}-${capability.value}`}
                            >
                              <FieldTitle>{capability.label}</FieldTitle>
                            </FieldLabel>
                          </FieldContent>
                        </Field>
                      );
                    })}
                </div>
              </Field>
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </FieldGroup>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                disabled={pendingAction === "save"}
                onClick={() => setEditOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={pendingAction === "save" || !name.trim()}
              >
                {pendingAction === "save" ? <Spinner /> : null}
                Save
              </Button>
            </DialogFooter>
          </form>
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
              {pendingAction === "remove" ? "Removing…" : "Remove"}
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
