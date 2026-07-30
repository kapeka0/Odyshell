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
import { BotIcon, CableIcon, CpuIcon, KeyRoundIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import type { CloudContext } from "@/lib/cloud-api";
import { cn } from "@/lib/utils";

type MachineNodeData = {
  name: string;
  online: boolean;
  connections: number;
};

type AgentNodeData = {
  name: string;
  connections: number;
};

type MachineFlowNode = Node<MachineNodeData, "machine">;
type AgentFlowNode = Node<AgentNodeData, "agent">;
type TopologyNode = MachineFlowNode | AgentFlowNode;

const nodeTypes = {
  machine: MachineNode,
  agent: AgentNode,
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
          gap={20}
          size={1.4}
          color="var(--muted-foreground)"
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
            label={`${connections.connectedAgents} agents connected`}
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
            <Button
              size="sm"
              disabled
              title="Machine limit reached for this plan"
            >
              <PlusIcon data-icon="inline-start" />
              Add machine
            </Button>
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
          <span
            aria-label={data.online ? "Online" : "Offline"}
            className={cn(
              "absolute -top-1 -right-1 size-2.5 rounded-full border-2 border-card",
              data.online
                ? "bg-emerald-500 motion-safe:animate-pulse"
                : "bg-muted-foreground/45",
            )}
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
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-foreground text-background">
          <BotIcon aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <Link
            href="/dashboard/agents"
            className="nodrag block truncate font-medium hover:underline"
          >
            {data.name}
          </Link>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Interacting now
          </span>
        </span>
      </div>
      <div className="mt-4 border-t pt-3 text-xs text-muted-foreground">
        {data.connections} active{" "}
        {data.connections === 1 ? "connection" : "connections"}
      </div>
    </div>
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
  const connections = context.connections?.connections ?? [];
  const agents = [
    ...new Map(
      connections.map((connection) => [
        connection.agentId,
        {
          id: connection.agentId,
          name: connection.agentName,
          connections: connections.filter(
            (candidate) => candidate.agentId === connection.agentId,
          ).length,
        },
      ]),
    ).values(),
  ];
  const hasAgents = agents.length > 0;
  const agentNodes: AgentFlowNode[] = agents.map((agent, index) => ({
    id: `agent:${agent.id}`,
    type: "agent",
    position: { x: 80, y: 130 + index * 170 },
    data: { name: agent.name, connections: agent.connections },
    draggable: true,
  }));
  const machineNodes: MachineFlowNode[] = context.machines.map(
    (machine, index) => ({
      id: `machine:${machine.id}`,
      type: "machine",
      position: hasAgents
        ? { x: 600, y: 100 + index * 165 }
        : {
            x: 210 + (index % 3) * 300,
            y: 150 + Math.floor(index / 3) * 170,
          },
      data: {
        name: machine.name,
        online: machine.online,
        connections: connections.filter(
          (connection) => connection.machineId === machine.id,
        ).length,
      },
      draggable: true,
    }),
  );
  const edges: Edge[] = connections.map((connection) => ({
    id: `connection:${connection.id}`,
    source: `agent:${connection.agentId}`,
    target: `machine:${connection.machineId}`,
    type: "smoothstep",
    animated: animateConnections,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
  }));

  return { nodes: [...agentNodes, ...machineNodes], edges };
}

const emptyConnections: CloudContext["connections"] = {
  activeConnections: 0,
  connectedAgents: 0,
  connections: [],
};

function emptySubscribe() {
  return () => {};
}
