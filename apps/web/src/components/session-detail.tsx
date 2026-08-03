"use client";

import {
  BotIcon,
  CheckIcon,
  CircleIcon,
  ShieldCheckIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  AgentIdentityAvatar,
  UserIdentityAvatar,
} from "@/components/identity-avatar";
import { CopyableValue } from "@/components/copyable-value";
import { StatusBadge } from "@/components/status-badge";
import { useDashboard } from "@/components/dashboard-provider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Timeline,
  TimelineConnector,
  TimelineContent,
  TimelineItem,
  TimelineMarker,
} from "@/components/ui/timeline";
import type {
  SessionTimelineDetail,
  SessionTimelineEvent,
} from "@/lib/cloud-api";

export function SessionDetail({ initial }: { initial: SessionTimelineDetail }) {
  const { state } = useDashboard();
  const [detail, setDetail] = useState(initial);
  const listRef = useRef<HTMLDivElement>(null);
  const stayAtBottom = useRef(true);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const response = await fetch(`/api/sessions/${initial.session.id}/timeline`, {
        cache: "no-store",
      });
      if (!response.ok || !active) return;
      const next = (await response.json()) as SessionTimelineDetail;
      setDetail(next);
    };
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [initial.session.id]);

  useEffect(() => {
    if (stayAtBottom.current) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [detail.timeline.length]);

  const members = new Map(
    (state.status === "ready" ? state.context.members : []).map((member) => [member.id, member]),
  );
  const agents = new Map(
    (state.status === "ready" ? state.context.agents : []).map((agent) => [agent.id, agent]),
  );
  const requesterAgent = detail.session.requestedByAgentId
    ? agents.get(detail.session.requestedByAgentId)
    : undefined;
  const requesterMember = detail.session.requestedByHumanId
    ? members.get(detail.session.requestedByHumanId)
    : undefined;
  const requester = detail.session.requestedByAgentId
    ? {
        kind: "agent" as const,
        id: detail.session.requestedByAgentId,
        name: requesterAgent?.name ?? "Agent",
      }
    : detail.session.requestedByHumanId
      ? {
          kind: "human" as const,
          id: detail.session.requestedByHumanId,
          name: requesterMember?.name ?? "Member",
          imageUrl: requesterMember?.imageUrl,
        }
      : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <Card className="min-h-0">
        <CardHeader className="border-b">
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Timeline</CardTitle>
            <span className="text-sm text-muted-foreground">{detail.timeline.length} events</span>
          </div>
        </CardHeader>
        <CardContent
          ref={listRef}
          className="max-h-[calc(100vh-15rem)] overflow-y-auto p-5"
          onScroll={(event) => {
            const node = event.currentTarget;
            stayAtBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          }}
        >
          <Timeline>
            {detail.timeline.map((event) => (
              <SessionEvent
                key={event.id}
                event={event}
                agentName={detail.session.agentName ?? "Agent"}
                agents={agents}
                members={members}
                requester={requester}
              />
            ))}
          </Timeline>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader><CardTitle>Session</CardTitle></CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-4 text-sm">
              <Detail label="Session ID">
                <CopyableValue
                  value={initial.session.id}
                  label="Session ID"
                  className="break-all font-mono text-xs"
                />
              </Detail>
              <Detail label="Status"><StatusBadge status={detail.session.status} /></Detail>
              <Detail label="Agent">
                <span className="flex items-center gap-2">
                  <AgentIdentityAvatar name={detail.session.agentName ?? "Agent"} className="size-6" />
                  {detail.session.agentName ?? "Agent"}
                </span>
              </Detail>
              <Detail label="Requester">
                {requester?.kind === "agent" ? (
                  <span className="flex items-center gap-2">
                    <AgentIdentityAvatar name={requester.name} className="size-6" />
                    {requester.name}
                  </span>
                ) : requester?.kind === "human" ? (
                  <span className="flex items-center gap-2">
                    <UserIdentityAvatar
                      identity={requester.id}
                      imageUrl={requester.imageUrl}
                      name={requester.name}
                      className="size-6"
                    />
                    {requester.name}
                  </span>
                ) : "System"}
              </Detail>
              <Detail label="Expires">{formatTimestamp(detail.session.expiresAt)}</Detail>
              {detail.session.purpose ? <Detail label="Purpose">{detail.session.purpose}</Detail> : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Scope</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-4">
            {(detail.session.scopes ?? []).map((scope) => (
              <div key={scope.machineId} className="flex flex-col gap-2 text-sm">
                <p className="font-medium">
                  {detail.session.targets.find((target) => target.machineId === scope.machineId)?.machineName ?? "Unavailable"}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {scope.capabilities.map((capability) => <Badge key={capability} variant="outline">{capability}</Badge>)}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SessionEvent({
  event,
  agentName,
  agents,
  members,
  requester,
}: {
  event: SessionTimelineEvent;
  agentName: string;
  agents: Map<string, { id: string; name: string }>;
  members: Map<string, { id: string; name: string; imageUrl?: string }>;
  requester:
    | { kind: "agent"; id: string; name: string }
    | { kind: "human"; id: string; name: string; imageUrl?: string }
    | null;
}) {
  const actor = eventActor(event, agentName, agents, members, requester);
  return (
    <TimelineItem>
      <TimelineConnector />
      <TimelineMarker>{eventIcon(event)}</TimelineMarker>
      <TimelineContent>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="font-medium">{eventLabel(event.eventType)}</p>
          <time className="text-xs text-muted-foreground" dateTime={event.createdAt}>{formatTimestamp(event.createdAt)}</time>
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          {actor.kind === "agent" ? <AgentIdentityAvatar name={actor.name} className="size-5" /> : actor.kind === "human" ? (
            <UserIdentityAvatar identity={actor.id} imageUrl={actor.imageUrl} name={actor.name} className="size-5" />
          ) : <span className="flex size-5 items-center justify-center rounded-full border"><ShieldCheckIcon className="size-3" /></span>}
          {actor.name}
        </div>
        <EventMetadata metadata={event.metadata} />
      </TimelineContent>
    </TimelineItem>
  );
}

function EventMetadata({ metadata }: { metadata: Record<string, unknown> }) {
  const command = typeof metadata.command === "string"
    ? metadata.command
    : typeof metadata.program === "string"
      ? [metadata.program, ...(Array.isArray(metadata.args) ? metadata.args.filter((value): value is string => typeof value === "string") : [])].join(" ")
      : null;
  const exitCode = typeof metadata.exitCode === "number" ? metadata.exitCode : null;
  const status = typeof metadata.status === "string" ? metadata.status : null;
  if (!command && exitCode === null && !status) return null;
  return (
    <div className="mt-2 rounded-md border bg-muted/35 px-3 py-2 text-xs">
      {command ? <code className="block overflow-x-auto whitespace-pre-wrap break-all">{command}</code> : null}
      {status || exitCode !== null ? (
        <p className="mt-1 text-muted-foreground">{status ?? "Completed"}{exitCode !== null ? ` · Exit ${exitCode}` : ""}</p>
      ) : null}
    </div>
  );
}

function eventActor(
  event: SessionTimelineEvent,
  agentName: string,
  agents: Map<string, { id: string; name: string }>,
  members: Map<string, { id: string; name: string; imageUrl?: string }>,
  requester:
    | { kind: "agent"; id: string; name: string }
    | { kind: "human"; id: string; name: string; imageUrl?: string }
    | null,
) {
  const actorHumanId = typeof event.metadata.actorHumanId === "string"
    ? event.metadata.actorHumanId
    : undefined;
  if (actorHumanId) {
    const member = members.get(actorHumanId);
    return {
      kind: "human" as const,
      id: actorHumanId,
      name: member?.name ?? "Member",
      imageUrl: member?.imageUrl,
    };
  }
  const actorAgentId = typeof event.metadata.actorAgentId === "string"
    ? event.metadata.actorAgentId
    : undefined;
  if (actorAgentId) {
    return {
      kind: "agent" as const,
      name: agents.get(actorAgentId)?.name ?? agentName,
    };
  }
  if (requester && event.eventType === "session.requested") {
    return requester;
  }
  return { kind: "system" as const, name: "Odyshell" };
}

function eventIcon(event: SessionTimelineEvent) {
  if (event.eventType.startsWith("operation.")) return <TerminalIcon />;
  if (/failed|denied|revoked|cancelled/u.test(event.eventType)) return <XIcon />;
  if (/completed|ready|approved/u.test(event.eventType)) return <CheckIcon />;
  if (event.source === "agent") return <BotIcon />;
  return <CircleIcon />;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 break-words">{children}</dd></div>;
}

function eventLabel(value: string) {
  const label = value.replaceAll(".", " ").replaceAll("_", " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
