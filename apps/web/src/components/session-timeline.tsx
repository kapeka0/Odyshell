"use client";

import { BotIcon, CircleXIcon, Clock3Icon, TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Timeline, TimelineConnector, TimelineContent, TimelineItem, TimelineMarker } from "@/components/ui/timeline";
import { formatDashboardTimestamp } from "@/lib/date-time";
import type { CloudCommand, CloudSessionTimeline } from "@/lib/cloud-api";

export function SessionTimeline({ sessionId, timeZone }: { sessionId: string; timeZone: string }) {
  const [timeline, setTimeline] = useState<CloudSessionTimeline>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as CloudSessionTimeline & { error?: string };
      if (!response.ok || !body.session) throw new Error(body.error ?? "Could not load Session timeline");
      setTimeline(body);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Session timeline");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  if (loading) return <div className="flex min-h-64 items-center justify-center"><Spinner className="size-5" /></div>;
  if (error || !timeline) {
    return (
      <Alert variant="destructive">
        <CircleXIcon />
        <AlertTitle>Timeline unavailable</AlertTitle>
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>{error ?? "Session not found"}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button>
        </AlertDescription>
      </Alert>
    );
  }

  const { session, commands, events } = timeline;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>{session.title}</CardTitle>
              {session.purpose ? <p className="mt-1 text-sm text-muted-foreground">{session.purpose}</p> : null}
            </div>
            <StatusBadge status={session.status}>{label(session.status)}</StatusBadge>
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          <Timeline>
            {events.map((event) => {
              const command = event.commandId ? commands.find((item) => item.id === event.commandId) : undefined;
              return (
                <TimelineItem key={event.id}>
                  <TimelineConnector />
                  <TimelineMarker>{command ? <TerminalIcon /> : <BotIcon />}</TimelineMarker>
                  <TimelineContent>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium">{eventLabel(event.type)}</p>
                      <time className="text-xs text-muted-foreground" dateTime={event.createdAt}>{formatDashboardTimestamp(event.createdAt, timeZone)}</time>
                    </div>
                    {command && event.type === "command.created" ? <CommandTrace command={command} /> : <EventMetadata metadata={event.metadata} />}
                  </TimelineContent>
                </TimelineItem>
              );
            })}
            {events.length === 0 ? <p className="text-sm text-muted-foreground">No recorded events.</p> : null}
          </Timeline>
        </CardContent>
      </Card>

      <aside className="space-y-4">
        <Card>
          <CardHeader><CardTitle>Authority</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <Detail label="Agent" value={session.agentId} mono />
              <Detail label="Machine" value={session.machineId} mono />
              <Detail label="OS user" value={session.operatingSystemUser} mono />
              <Detail label="Started" value={formatDashboardTimestamp(session.readyAt ?? session.createdAt, timeZone)} />
              <Detail label="Expires" value={formatDashboardTimestamp(session.expiresAt, timeZone)} />
            </dl>
          </CardContent>
        </Card>
        <div className="flex items-start gap-2 rounded-xl border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
          <Clock3Icon className="mt-0.5 size-3.5 shrink-0" />
          Commands, lifecycle decisions and available output are attributable to this Session.
        </div>
      </aside>
    </div>
  );
}

function CommandTrace({ command }: { command: CloudCommand }) {
  const output = decodeOutput(command);
  return (
    <div className="mt-3 overflow-hidden rounded-lg border bg-neutral-950 text-neutral-100">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2 text-xs">
        <code className="truncate text-neutral-200">$ {command.command}</code>
        <span className="shrink-0 text-neutral-400">{command.status}{command.exitCode === null ? "" : ` · exit ${command.exitCode}`}</span>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">
        {output || <span className="text-neutral-500">No output recorded.</span>}
      </pre>
      {command.outputTruncated ? <p className="border-t border-white/10 px-3 py-2 text-xs text-amber-300">Output was truncated at the Machine policy limit.</p> : null}
    </div>
  );
}

function decodeOutput(command: CloudCommand): string {
  const decoder = new TextDecoder();
  return command.output
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .map((chunk) => {
      try {
        const binary = window.atob(chunk.dataBase64);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return decoder.decode(bytes);
      } catch {
        return "[unreadable output]";
      }
    })
    .join("");
}

function EventMetadata({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value));
  if (entries.length === 0) return null;
  return <p className="mt-1 text-xs text-muted-foreground">{entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}</p>;
}

function Detail({ label: name, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt className="text-xs text-muted-foreground">{name}</dt><dd className={mono ? "mt-1 break-all font-mono text-xs" : "mt-1"}>{value}</dd></div>;
}

function label(value: string): string {
  return value.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    "session.requested": "Session requested",
    "session.approved": "Human approved the Session",
    "session.denied": "Human denied the Session",
    "session.opened": "Machine opened the Session",
    "session.completed": "Session completed",
    "session.closed": "Session closed",
    "command.created": "Command requested",
    "command.started": "Command started",
    "command.completed": "Command completed",
  };
  return labels[type] ?? label(type.replaceAll(".", " "));
}
