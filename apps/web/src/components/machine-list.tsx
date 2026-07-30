"use client";

import { CpuIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CloudMachine } from "@/lib/cloud-api";

export function MachineList({ machines }: { machines: CloudMachine[] }) {
  const online = machines.filter((machine) => machine.online).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Machines</CardTitle>
        <CardDescription>Clients enrolled in this workspace.</CardDescription>
        <CardAction>
          <Badge variant={online > 0 ? "default" : "outline"}>
            {online} online
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {machines.length === 0 ? (
          <Empty className="min-h-48 border-y">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CpuIcon />
              </EmptyMedia>
              <EmptyTitle>No machines yet</EmptyTitle>
              <EmptyDescription>
                Generate the command beside this list to connect one.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Machine</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">
                  Last seen
                </TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {machines.map((machine) => (
                <MachineRow key={machine.id} machine={machine} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function MachineRow({ machine }: { machine: CloudMachine }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function removeMachine() {
    setPending(true);
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
      setOpen(false);
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not remove machine",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <TableRow>
      <TableCell className="font-heading font-medium">
        <div>{machine.name}</div>
        {error ? (
          <div className="mt-1 max-w-52 whitespace-normal text-xs text-destructive">
            {error}
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-2">
          <span
            className={
              machine.online
                ? "size-2 rounded-full bg-[var(--color-success)]"
                : "size-2 rounded-full bg-muted-foreground"
            }
            aria-hidden="true"
          />
          {machine.online ? "Online" : machine.status}
        </span>
      </TableCell>
      <TableCell className="hidden text-muted-foreground sm:table-cell">
        {formatTimestamp(machine.lastSeenAt)}
      </TableCell>
      <TableCell className="text-right">
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${machine.name}`}
              />
            }
          >
            <Trash2Icon />
            <span className="hidden md:inline">Remove</span>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {machine.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The Client will disconnect and active operations will be
                cancelled. Reconnecting it later requires a new enrollment.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={removeMachine}
                disabled={pending}
              >
                {pending ? "Removing…" : "Remove machine"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
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
