"use client";

import { CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
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
import type { ControlSession } from "@/lib/control-api";

type Decision = { session: ControlSession; action: "approve" | "deny" };

export function SessionList() {
  const { state } = useDashboard();
  const context = state.status === "ready" ? state.context : null;
  const [sessions, setSessions] = useState<ControlSession[]>(context?.sessions ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [decision, setDecision] = useState<Decision>();
  const [deciding, setDeciding] = useState(false);
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
      const response = await fetch("/api/sessions", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as {
        data?: ControlSession[];
        error?: string;
      };
      if (!response.ok || !body.data) throw new Error(body.error ?? "Could not load Sessions");
      setSessions(body.data);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Sessions");
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const pending = sessions.filter((session) => session.status === "pending_approval");

  async function decide() {
    if (!decision) return;
    setDeciding(true);
    try {
      const response = await fetch(`/api/sessions/${decision.session.id}/${decision.action}`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        session?: ControlSession;
        delivery?: "sent" | "pending";
        error?: string;
      };
      if (!response.ok || !body.session) {
        throw new Error(body.error ?? `Could not ${decision.action} Session`);
      }
      setSessions((current) => current.map((session) => session.id === body.session!.id ? body.session! : session));
      toast.add({
        title: decision.action === "approve" ? "Session approved" : "Session denied",
        description: body.delivery === "pending"
          ? "Authority will be delivered when the Machine reconnects."
          : undefined,
        type: "success",
      });
      setDecision(undefined);
    } catch (cause) {
      toast.add({
        title: decision.action === "approve" ? "Session not approved" : "Session not denied",
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
        <span className="sr-only">Loading Sessions</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {error ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Sessions are unavailable</AlertTitle>
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

      <section aria-labelledby="pending-sessions-title" className="space-y-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="pending-sessions-title" className="text-base font-medium">Needs a decision</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Standard Agents require a Human decision. Operators open Sessions directly.
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
            {pending.map((session) => (
              <Card key={session.id}>
                <CardHeader>
                  <CardTitle>{session.title}</CardTitle>
                  <CardDescription>
                    {agentName(session, agents)} → {machineName(session, machines)}
                  </CardDescription>
                  <CardAction>
                    <StatusBadge status={session.status}>{sessionStatusLabel(session.status)}</StatusBadge>
                  </CardAction>
                </CardHeader>
                <CardContent className="space-y-4">
                  {session.purpose ? (
                    <p className="text-sm leading-6 text-muted-foreground">{session.purpose}</p>
                  ) : null}
                  <dl className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <dt className="text-muted-foreground">OS user</dt>
                      <dd className="mt-1 font-mono text-foreground">{session.operatingSystemUser}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Expires</dt>
                      <dd className="mt-1 text-foreground">
                        {formatDashboardTimestamp(session.expiresAt, timeZone)}
                      </dd>
                    </div>
                  </dl>
                  <div className="flex justify-end gap-2 border-t pt-4">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDecision({ session, action: "deny" })}
                    >
                      Deny
                    </Button>
                    <Button size="sm" onClick={() => setDecision({ session, action: "approve" })}>
                      Approve
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="session-history-title" className="space-y-3">
        <div>
          <h2 id="session-history-title" className="text-base font-medium">Recent Sessions</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Temporary authority and its current delivery state.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Session</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Machine</TableHead>
                <TableHead>Authority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right">Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-28 text-center text-muted-foreground">
                    No Agent has requested a Session yet.
                  </TableCell>
                </TableRow>
              ) : sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell className="max-w-64 pl-4">
                    <Link href={`/dashboard/sessions/${session.id}`} className="truncate font-medium hover:underline">{session.title}</Link>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {session.id}
                    </p>
                  </TableCell>
                  <TableCell>{agentName(session, agents)}</TableCell>
                  <TableCell>{machineName(session, machines)}</TableCell>
                  <TableCell className="font-mono text-xs">{session.operatingSystemUser}</TableCell>
                  <TableCell>
                    <StatusBadge status={session.status}>{sessionStatusLabel(session.status)}</StatusBadge>
                  </TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground">
                    {formatDashboardTimestamp(session.expiresAt, timeZone)}
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
              {decision?.action === "approve" ? "Approve this Session?" : "Deny this Session?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {decision?.action === "approve"
                ? `This grants ${decision ? agentName(decision.session, agents) : "the Agent"} temporary shell authority as ${decision?.session.operatingSystemUser ?? "the configured user"}.`
                : "The Agent will not receive Machine authority for this Session."}
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
              {decision?.action === "approve" ? "Approve Session" : "Deny Session"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function agentName(session: ControlSession, agents: Map<string, string>): string {
  return agents.get(session.agentId) ?? `Agent ${session.agentId.slice(0, 8)}`;
}

function machineName(session: ControlSession, machines: Map<string, string>): string {
  return machines.get(session.machineId) ?? `Machine ${session.machineId.slice(0, 8)}`;
}

function sessionStatusLabel(status: ControlSession["status"]): string {
  return status.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}
