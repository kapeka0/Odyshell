"use client";

import { CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDashboard } from "@/components/dashboard-provider";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { formatDashboardTimestamp } from "@/lib/date-time";
import type { CloudTask } from "@/lib/cloud-api";

type Decision = { task: CloudTask; action: "approve" | "deny" };

export function TaskList() {
  const { state } = useDashboard();
  const [tasks, setTasks] = useState<CloudTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [decision, setDecision] = useState<Decision>();
  const [deciding, setDeciding] = useState(false);
  const context = state.status === "ready" ? state.context : null;
  const timeZone = context?.userPreferences.timeZone ?? "System";
  const agents = useMemo(
    () => new Map((context?.agents ?? []).map((agent) => [agent.id, agent.name])),
    [context?.agents],
  );
  const machines = useMemo(
    () => new Map((context?.machines ?? []).map((machine) => [machine.id, machine.name])),
    [context?.machines],
  );

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/tasks", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as {
        data?: CloudTask[];
        error?: string;
      };
      if (!response.ok || !body.data) throw new Error(body.error ?? "Could not load Tasks");
      setTasks(body.data);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Tasks");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void load().finally(() => setLoading(false));
    }, 0);
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  const pending = tasks.filter((task) => task.status === "pending_approval");

  async function decide() {
    if (!decision) return;
    setDeciding(true);
    try {
      const response = await fetch(`/api/tasks/${decision.task.id}/${decision.action}`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        task?: CloudTask;
        delivery?: "sent" | "pending";
        error?: string;
      };
      if (!response.ok || !body.task) {
        throw new Error(body.error ?? `Could not ${decision.action} Task`);
      }
      setTasks((current) => current.map((task) => task.id === body.task!.id ? body.task! : task));
      toast.add({
        title: decision.action === "approve" ? "Task approved" : "Task denied",
        description: body.delivery === "pending"
          ? "Authority will be delivered when the Machine reconnects."
          : undefined,
        type: "success",
      });
      setDecision(undefined);
    } catch (cause) {
      toast.add({
        title: decision.action === "approve" ? "Task not approved" : "Task not denied",
        description: cause instanceof Error ? cause.message : "Try again.",
        type: "error",
      });
    } finally {
      setDeciding(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-48 items-center justify-center rounded-xl border bg-card">
        <Spinner className="size-5" />
        <span className="sr-only">Loading Tasks</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {error ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Tasks are unavailable</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => {
              setLoading(true);
              void load().finally(() => setLoading(false));
            }}>
              <RefreshCwIcon /> Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="pending-tasks-title" className="space-y-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="pending-tasks-title" className="text-base font-medium">Needs a decision</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Only Tasks outside the current autonomy policy appear here.
            </p>
          </div>
          <span className="text-sm tabular-nums text-muted-foreground">{pending.length}</span>
        </div>
        {pending.length === 0 ? (
          <div className="rounded-xl border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">
            Agents are operating inside policy. No human decision is waiting.
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {pending.map((task) => (
              <Card key={task.id}>
                <CardHeader>
                  <CardTitle>{task.title}</CardTitle>
                  <CardDescription>
                    {agentName(task, agents)} → {machineName(task, machines)}
                  </CardDescription>
                  <CardAction>
                    <StatusBadge status={task.status}>{taskStatusLabel(task.status)}</StatusBadge>
                  </CardAction>
                </CardHeader>
                <CardContent className="space-y-4">
                  {task.purpose ? (
                    <p className="text-sm leading-6 text-muted-foreground">{task.purpose}</p>
                  ) : null}
                  <dl className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <dt className="text-muted-foreground">OS user</dt>
                      <dd className="mt-1 font-mono text-foreground">{task.operatingSystemUser}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Expires</dt>
                      <dd className="mt-1 text-foreground">
                        {formatDashboardTimestamp(task.expiresAt, timeZone)}
                      </dd>
                    </div>
                  </dl>
                  <div className="flex justify-end gap-2 border-t pt-4">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDecision({ task, action: "deny" })}
                    >
                      Deny
                    </Button>
                    <Button size="sm" onClick={() => setDecision({ task, action: "approve" })}>
                      Approve
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="task-history-title" className="space-y-3">
        <div>
          <h2 id="task-history-title" className="text-base font-medium">Recent Tasks</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Temporary authority and its current delivery state.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Task</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Machine</TableHead>
                <TableHead>Authority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right">Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-28 text-center text-muted-foreground">
                    No Agent has requested a Task yet.
                  </TableCell>
                </TableRow>
              ) : tasks.map((task) => (
                <TableRow key={task.id}>
                  <TableCell className="max-w-64 pl-4">
                    <p className="truncate font-medium">{task.title}</p>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {task.id}
                    </p>
                  </TableCell>
                  <TableCell>{agentName(task, agents)}</TableCell>
                  <TableCell>{machineName(task, machines)}</TableCell>
                  <TableCell className="font-mono text-xs">{task.operatingSystemUser}</TableCell>
                  <TableCell>
                    <StatusBadge status={task.status}>{taskStatusLabel(task.status)}</StatusBadge>
                  </TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground">
                    {formatDashboardTimestamp(task.expiresAt, timeZone)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <AlertDialog open={decision !== undefined} onOpenChange={(open) => {
        if (!open && !deciding) setDecision(undefined);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {decision?.action === "approve" ? "Approve this Task?" : "Deny this Task?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {decision?.action === "approve"
                ? `This grants ${decision ? agentName(decision.task, agents) : "the Agent"} temporary shell authority as ${decision?.task.operatingSystemUser ?? "the configured user"}.`
                : "The Agent will not receive Machine authority for this Task."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deciding}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={decision?.action === "deny" ? "destructive" : "default"}
              disabled={deciding}
              onClick={(event) => {
                event.preventDefault();
                void decide();
              }}
            >
              {deciding ? <Spinner /> : null}
              {decision?.action === "approve" ? "Approve Task" : "Deny Task"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function agentName(task: CloudTask, agents: Map<string, string>): string {
  return agents.get(task.agentId) ?? `Agent ${task.agentId.slice(0, 8)}`;
}

function machineName(task: CloudTask, machines: Map<string, string>): string {
  return machines.get(task.machineId) ?? `Machine ${task.machineId.slice(0, 8)}`;
}

function taskStatusLabel(status: CloudTask["status"]): string {
  return status.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}
