"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { CableIcon, CpuIcon, PlusIcon, ShieldCheckIcon, TimerIcon } from "lucide-react";
import { useReducedMotion } from "motion/react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AgentIdentityAvatar } from "@/components/identity-avatar";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import type { CloudContext, CloudSession } from "@/lib/cloud-api";
import { cn } from "@/lib/utils";

type MachineNode = Node<{
  name: string;
  online: boolean;
  sessions: number;
}, "machine">;

type AgentNode = Node<{
  name: string;
  role: "standard" | "operator";
  sessions: number;
}, "agent">;

type SessionNode = Node<{
  id: string;
  title: string;
  status: CloudSession["status"];
  expiresAt: string;
}, "session">;

type TopologyNode = MachineNode | AgentNode | SessionNode;

const nodeTypes = {
  machine: MachineCard,
  agent: AgentCard,
  session: SessionCard,
};

export function WorkspaceCanvas({ context }: { context: CloudContext }) {
  const { resolvedTheme } = useTheme();
  const reduceMotion = useReducedMotion();
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const topology = useMemo(
    () => topologyFor(context, !reduceMotion),
    [context, reduceMotion],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<TopologyNode>(topology.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(topology.edges);

  useEffect(() => {
    setNodes((current) => {
      const positions = new Map(current.map((node) => [node.id, node.position]));
      return topology.nodes.map((node) => ({
        ...node,
        position: positions.get(node.id) ?? node.position,
      }));
    });
    setEdges(topology.edges);
  }, [setEdges, setNodes, topology]);

  if (!mounted) {
    return <section aria-label="Live organization topology" className="min-h-0 flex-1 rounded-xl border bg-background" />;
  }

  const onlineMachines = context.machines.filter((machine) => machine.online).length;
  const liveSessions = liveSessionsFor(context.sessions).length;

  return (
    <section aria-label="Live organization topology" className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-background">
      <ReactFlow<TopologyNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        minZoom={0.45}
        maxZoom={1.8}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
        proOptions={{ hideAttribution: true }}
        className="odyshell-flow"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
        <Controls position="bottom-left" showInteractive={false} />
        <Panel position="top-left" className="m-3 flex max-w-[calc(100%-7rem)] flex-wrap gap-2">
          <CanvasMetric icon={<CpuIcon />} label={`${onlineMachines}/${context.machines.length} machines online`} />
          <CanvasMetric icon={<TimerIcon />} label={`${liveSessions} live ${liveSessions === 1 ? "session" : "sessions"}`} />
          <CanvasMetric icon={<CableIcon />} label={`${context.connections.connectedAgents} connected agents`} className="hidden sm:inline-flex" />
        </Panel>
        <Panel position="top-right" className="m-3">
          <Link href="/dashboard/machines/add" className={buttonVariants({ size: "sm" })}>
            <PlusIcon data-icon="inline-start" /> Add machine
          </Link>
        </Panel>
      </ReactFlow>
    </section>
  );
}

function MachineCard({ data }: NodeProps<MachineNode>) {
  return (
    <div className="w-60 rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <Handle type="target" position={Position.Left} className="opacity-0" isConnectable={false} />
      <div className="flex items-start gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
          <CpuIcon aria-hidden="true" className="size-4" />
          <StatusDot active={data.online} className="absolute -right-1 -top-1 size-2.5 rounded-full ring-2 ring-card" />
        </span>
        <span className="min-w-0 flex-1">
          <Link href="/dashboard/machines" className="nodrag block truncate font-medium hover:underline">{data.name}</Link>
          <span className="mt-0.5 block text-xs text-muted-foreground">{data.online ? "Online" : "Offline"}</span>
        </span>
      </div>
      <div className="mt-4 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
        <span>{data.sessions} live {data.sessions === 1 ? "session" : "sessions"}</span>
        <span>Machine</span>
      </div>
    </div>
  );
}

function AgentCard({ data }: NodeProps<AgentNode>) {
  return (
    <div className="w-52 rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <Handle type="source" position={Position.Right} className="opacity-0" isConnectable={false} />
      <div className="flex items-start gap-3">
        <AgentIdentityAvatar name={data.name} className="size-9" />
        <span className="min-w-0 flex-1">
          <Link href="/dashboard/agents" className="nodrag block truncate font-medium hover:underline">{data.name}</Link>
          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            {data.role === "operator" ? <ShieldCheckIcon className="size-3" /> : null}
            {data.role === "operator" ? "Operator" : "Standard"}
          </span>
        </span>
      </div>
      <div className="mt-4 border-t pt-3 text-xs text-muted-foreground">
        {data.sessions} live {data.sessions === 1 ? "session" : "sessions"}
      </div>
    </div>
  );
}

function SessionCard({ data }: NodeProps<SessionNode>) {
  return (
    <div className="w-56 rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <Handle type="target" position={Position.Left} className="opacity-0" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="opacity-0" isConnectable={false} />
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
          <TimerIcon aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <Link href={`/dashboard/sessions/${data.id}`} className="nodrag block truncate font-medium hover:underline">{data.title}</Link>
          <span className="mt-0.5 block text-xs capitalize text-muted-foreground">{data.status.replaceAll("_", " ")}</span>
        </span>
      </div>
      <div className="mt-4 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
        <time dateTime={data.expiresAt}>{remaining(data.expiresAt)}</time>
        <span>Session</span>
      </div>
    </div>
  );
}

function CanvasMetric({ icon, label, className }: { icon: React.ReactNode; label: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 bg-background/92 shadow-sm", className)}>
      <span aria-hidden="true" className="[&_svg]:size-3.5">{icon}</span>{label}
    </Badge>
  );
}

function topologyFor(context: CloudContext, animated: boolean): { nodes: TopologyNode[]; edges: Edge[] } {
  const sessions = liveSessionsFor(context.sessions);
  const agents = context.agents.filter((agent) => agent.status === "active");
  const agentNodes: AgentNode[] = agents.map((agent, index) => ({
    id: `agent:${agent.id}`,
    type: "agent",
    position: { x: 70, y: 120 + index * 165 },
    data: {
      name: agent.name,
      role: agent.role,
      sessions: sessions.filter((session) => session.agentId === agent.id).length,
    },
    draggable: true,
  }));
  const sessionNodes: SessionNode[] = sessions.map((session, index) => ({
    id: `session:${session.id}`,
    type: "session",
    position: { x: 390, y: 110 + index * 165 },
    data: { id: session.id, title: session.title, status: session.status, expiresAt: session.expiresAt },
    draggable: true,
  }));
  const machineNodes: MachineNode[] = context.machines.map((machine, index) => ({
    id: `machine:${machine.id}`,
    type: "machine",
    position: { x: 730, y: 100 + index * 165 },
    data: {
      name: machine.name,
      online: machine.online,
      sessions: sessions.filter((session) => session.machineId === machine.id).length,
    },
    draggable: true,
  }));
  const edges: Edge[] = sessions.flatMap((session) => [
    {
      id: `agent-session:${session.id}`,
      source: `agent:${session.agentId}`,
      target: `session:${session.id}`,
      type: "smoothstep",
      animated,
      style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
    },
    {
      id: `session-machine:${session.id}`,
      source: `session:${session.id}`,
      target: `machine:${session.machineId}`,
      type: "smoothstep",
      animated: animated && session.status === "active",
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
    },
  ]);
  return { nodes: [...agentNodes, ...sessionNodes, ...machineNodes], edges };
}

function liveSessionsFor(sessions: CloudSession[]): CloudSession[] {
  return sessions.filter((session) => ["opening", "active", "cancellation_requested"].includes(session.status));
}

function remaining(expiresAt: string): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1_000));
  if (seconds === 0) return "Expired";
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.ceil(minutes / 60)}h left`;
}

function emptySubscribe() {
  return () => {};
}
