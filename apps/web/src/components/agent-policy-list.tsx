"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { ShieldCheckIcon } from "lucide-react";
import { useMemo } from "react";
import { CopyableValue } from "@/components/copyable-value";
import { DataTable, DataTableColumnHeader } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { CloudAgent, CloudAgentPolicy } from "@/lib/cloud-api";

export function AgentPolicyList({
  policies,
  agents,
}: {
  policies: CloudAgentPolicy[];
  agents: CloudAgent[];
}) {
  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const columns = useMemo<ColumnDef<CloudAgentPolicy>[]>(
    () => [
      {
        id: "search",
        accessorFn: (policy) =>
          `${policy.id} ${agentNames.get(policy.agentId) ?? policy.agentId}`,
      },
      {
        id: "agent",
        accessorFn: (policy) => agentNames.get(policy.agentId) ?? policy.agentId,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Agent" />
        ),
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">
              {agentNames.get(row.original.agentId) ?? "Agent"}
            </p>
            <CopyableValue
              value={row.original.id}
              label="Policy ID"
              className="font-mono text-xs text-muted-foreground"
            />
          </div>
        ),
      },
      {
        accessorKey: "version",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Version" />
        ),
        cell: ({ row }) => `v${row.original.version}`,
      },
      {
        accessorKey: "kind",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Kind" />
        ),
        cell: ({ row }) => label(row.original.kind),
        filterFn: "equals",
      },
      {
        accessorKey: "status",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => (
          <Badge
            variant={row.original.status === "active" ? "default" : "outline"}
          >
            {label(row.original.status)}
          </Badge>
        ),
        filterFn: "equals",
      },
      {
        id: "machines",
        accessorFn: (policy) => policy.scopes.length,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Machines" />
        ),
        cell: ({ row }) => row.original.scopes.length,
      },
      {
        accessorKey: "expiresAt",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Expires" />
        ),
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {new Intl.DateTimeFormat("en", {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(row.original.expiresAt))}
          </span>
        ),
      },
    ],
    [agentNames],
  );

  if (policies.length === 0) {
    return (
      <Empty className="min-h-64 rounded-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldCheckIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No policies yet</EmptyTitle>
          <EmptyDescription>
            Agent-proposed approval ceilings appear here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <DataTable
      columns={columns}
      data={policies}
      searchColumn="search"
      searchPlaceholder="Search policies…"
      filters={[
        {
          columnId: "kind",
          label: "Kind",
          options: [
            { label: "Autoapproval", value: "autoapproval" },
            { label: "Delegation", value: "delegation" },
            { label: "Managed", value: "managed" },
          ],
        },
        {
          columnId: "status",
          label: "Status",
          options: [
            { label: "Proposed", value: "proposed" },
            { label: "Active", value: "active" },
            { label: "Paused", value: "paused" },
            { label: "Revoked", value: "revoked" },
            { label: "Replaced", value: "replaced" },
          ],
        },
      ]}
      emptyMessage="No policies match these filters."
    />
  );
}

function label(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
