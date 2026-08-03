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
import {
  BotIcon,
  CableIcon,
  CpuIcon,
  KeyRoundIcon,
  PlusIcon,
  TimerIcon,
} from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  AgentIdentityAvatar,
  UserIdentityAvatar,
} from "@/components/identity-avatar";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import type { CloudContext } from "@/lib/cloud-api";
import { formatSessionRemaining } from "@/lib/session-time";
import { cn } from "@/lib/utils";

type MachineNodeData = {
  name: string;
  online: boolean;
  connections: number;
};

type AgentNodeData = {
  name: string;
  sessions: number;
  status: "active" | "disabled";
};

type SessionNodeData = {
  id: string;
  title: string;
  expiresAt: string;
  targets: number;
  requester: {
    kind: "human" | "agent";
    id: string;
    name: string;
    imageUrl?: string;
  } | null;
};

type MachineFlowNode = Node<MachineNodeData, "machine">;
type AgentFlowNode = Node<AgentNodeData, "agent">;
type SessionFlowNode = Node<SessionNodeData, "session">;
type TopologyNode = MachineFlowNode | AgentFlowNode | SessionFlowNode;

const nodeTypes = {
  machine: MachineNode,
  agent: AgentNode,
  session: SessionNode,
};

export function WorkspaceCanvas({ context }: { context: CloudContext }) {
  const { resolvedTheme } = useTheme();
  const reduceMotion = useReducedMotion();
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const topology = useMemo(
    () => topologyFor(context, !reduceMotion),
    [context, reduceMotion],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<TopologyNode>(
    topology.nodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(topology.edges);
  const connections = context.connections ?? emptyConnections;
  const onlineMachines = context.machines.filter(
    (machine) => machine.online,
  ).length;
  const machineLimitReached =
    context.usage.machines >= context.plan.machineLimit;

  useEffect(() => {
    setNodes((current) => {
      const positions = new Map(
        current.map((node) => [node.id, node.position]),
      );
      return topology.nodes.map((node) => ({
        ...node,
        position: positions.get(node.id) ?? node.position,
      }));
    });
    setEdges(topology.edges);
  }, [setEdges, setNodes, topology]);

  if (!mounted) {
    return (
      <section
        aria-label="Live workspace topology"
        className="min-h-0 flex-1 rounded-xl border bg-background"
      />
    );
  }

  return (
    <section
      aria-label="Live workspace topology"
      className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-background"
    >
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
        fitViewOptions={{ padding: 0.32, maxZoom: 1 }}
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
        proOptions={{ hideAttribution: true }}
        className="odyshell-flow"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="var(--color-rule-strong)"
        />
        <Controls
          position="bottom-left"
          showInteractive={false}
          className="overflow-hidden rounded-lg border shadow-sm"
        />
        <Panel
          position="top-left"
          className="m-3 flex max-w-[calc(100%-7.5rem)] flex-wrap gap-2"
        >
          <CanvasMetric
            icon={<CpuIcon />}
            label={`${onlineMachines}/${context.machines.length} machines online`}
          />
          <CanvasMetric
            icon={<BotIcon />}
            label={`${connections.connectedAgents} agents with sessions`}
          />
          <CanvasMetric
            icon={<CableIcon />}
            label={`${connections.activeConnections} live connections`}
            className="hidden sm:inline-flex"
          />
          <CanvasMetric
            icon={<KeyRoundIcon />}
            label={`${context.usage.activeAgents} active access`}
            className="hidden sm:inline-flex"
          />
        </Panel>
        <Panel position="top-right" className="m-3">
          {machineLimitReached ? (
            <div className="flex flex-col items-end gap-1">
              <Button size="sm" disabled>
                <PlusIcon data-icon="inline-start" />
                Add machine
              </Button>
              <p className="text-xs text-destructive">
                Machine limit reached
              </p>
            </div>
          ) : (
            <Link
              href="/dashboard/machines/add"
              className={buttonVariants({ size: "sm" })}
            >
              <PlusIcon data-icon="inline-start" />
              Add machine
            </Link>
          )}
        </Panel>
      </ReactFlow>
    </section>
  );
}

function MachineNode({ data }: NodeProps<MachineFlowNode>) {
  return (
    <div className="w-60 rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <Handle
        type="target"
        position={Position.Left}
        className="opacity-0"
        isConnectable={false}
      />
      <div className="flex items-start gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
          <CpuIcon aria-hidden="true" className="size-4" />
          <StatusDot
            active={data.online}
            className="absolute -top-1 -right-1 size-2.5 rounded-full ring-2 ring-card"
          />
        </span>
        <span className="min-w-0 flex-1">
          <Link
            href="/dashboard/machines"
            className="nodrag block truncate font-medium hover:underline"
          >
            {data.name}
          </Link>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {data.online ? "Online" : "Offline"}
          </span>
        </span>
      </div>
      <div className="mt-4 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
        <span>
          {data.connections}{" "}
          {data.connections === 1 ? "connection" : "connections"}
        </span>
        <span>Machine</span>
      </div>
    </div>
  );
}

function AgentNode({ data }: NodeProps<AgentFlowNode>) {
  return (
    <div className="w-52 rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <Handle
        type="source"
        position={Position.Right}
        className="opacity-0"
        isConnectable={false}
      />
      <div className="flex items-start gap-3">
        <AgentIdentityAvatar name={data.name} className="size-9" />
        <span className="min-w-0 flex-1">
          <Link
            href="/dashboard/agents"
            className="nodrag block truncate font-medium hover:underline"
          >
            {data.name}
          </Link>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {data.status === "disabled" ? "Disabled" : "Enabled"}
          </span>
        </span>
      </div>
      <div className="mt-4 border-t pt-3 text-xs text-muted-foreground">
        {data.sessions} active {data.sessions === 1 ? "session" : "sessions"}
      </div>
    </div>
  );
}

function SessionNode({ data }: NodeProps<SessionFlowNode>) {
  return (
    <div className="w-56 rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <Handle
        type="target"
        position={Position.Left}
        className="opacity-0"
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="opacity-0"
        isConnectable={false}
      />
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
          <TimerIcon aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <Link
            href={`/dashboard/sessions/${data.id}`}
            className="nodrag block truncate font-medium hover:underline"
          >
            {data.title}
          </Link>
          <SessionCountdown expiresAt={data.expiresAt} />
        </span>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
        <span>{data.targets} {data.targets === 1 ? "target" : "targets"}</span>
        {data.requester ? (
          <span className="flex min-w-0 items-center gap-1.5">
            {data.requester.kind === "agent" ? (
              <AgentIdentityAvatar name={data.requester.name} className="size-5" />
            ) : (
              <UserIdentityAvatar
                identity={data.requester.id}
                imageUrl={data.requester.imageUrl}
                name={data.requester.name}
                className="size-5"
              />
            )}
            <span className="max-w-20 truncate">{data.requester.name}</span>
          </span>
        ) : (
          <span>System</span>
        )}
      </div>
    </div>
  );
}

function SessionCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span
      aria-live="off"
      className="mt-0.5 block text-xs tabular-nums text-muted-foreground"
    >
      {formatSessionRemaining(expiresAt, now)}
    </span>
  );
}

function CanvasMetric({
  icon,
  label,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 bg-background/92 shadow-sm", className)}
    >
      <span aria-hidden="true" className="[&_svg]:size-3.5">
        {icon}
      </span>
      {label}
    </Badge>
  );
}

function topologyFor(
  context: CloudContext,
  animateConnections: boolean,
): {
  nodes: TopologyNode[];
  edges: Edge[];
} {
  const activeSessions = (context.sessions ?? []).filter(
    (session) => session.status === "active",
  );
  const agents = context.agents ?? [];
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const members = new Map((context.members ?? []).map((member) => [member.id, member]));
  const hasAgents = agents.length > 0;
  const agentNodes: AgentFlowNode[] = agents.map((agent, index) => ({
    id: `agent:${agent.id}`,
    type: "agent",
    position: { x: 80, y: 130 + index * 170 },
    data: {
      name: agent.name,
      sessions: activeSessions.filter(
        (session) => session.agentId === agent.id,
      ).length,
      status: agent.status,
    },
    draggable: true,
  }));
  const sessionNodes: SessionFlowNode[] = activeSessions.map(
    (session, index) => ({
      id: `session:${session.id}`,
      type: "session",
      position: { x: 410, y: 115 + index * 170 },
      data: {
        id: session.id,
        title: session.title,
        expiresAt: session.expiresAt,
        targets: session.targets.length,
        requester: session.requestedByAgentId
          ? {
              kind: "agent" as const,
              id: session.requestedByAgentId,
              name: agentsById.get(session.requestedByAgentId)?.name ?? "Agent",
            }
          : session.requestedByHumanId
            ? {
                kind: "human" as const,
                ...(members.get(session.requestedByHumanId) ?? {
                  id: session.requestedByHumanId,
                  name: "Member",
                }),
              }
            : null,
      },
      draggable: true,
    }),
  );
  const machineNodes: MachineFlowNode[] = context.machines.map(
    (machine, index) => ({
      id: `machine:${machine.id}`,
      type: "machine",
      position: hasAgents
        ? { x: 760, y: 100 + index * 165 }
        : {
            x: 210 + (index % 3) * 300,
            y: 150 + Math.floor(index / 3) * 170,
          },
      data: {
        name: machine.name,
        online: machine.online,
        connections: activeSessions.filter((session) =>
          session.targets.some((target) => target.machineId === machine.id),
        ).length,
      },
      draggable: true,
    }),
  );
  const edges: Edge[] = activeSessions.flatMap((session) => [
    {
      id: `agent-session:${session.id}`,
      source: `agent:${session.agentId}`,
      target: `session:${session.id}`,
      type: "smoothstep",
      animated: animateConnections,
      style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
    },
    ...session.targets.map((target) => ({
      id: `session-machine:${session.id}:${target.machineId}`,
      source: `session:${session.id}`,
      target: `machine:${target.machineId}`,
      type: "smoothstep",
      animated: animateConnections && target.status === "ready",
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
    })),
  ]);

  return { nodes: [...agentNodes, ...sessionNodes, ...machineNodes], edges };
}

const emptyConnections: CloudContext["connections"] = {
  activeConnections: 0,
  connectedAgents: 0,
  connections: [],
};

function emptySubscribe() {
  return () => {};
}
