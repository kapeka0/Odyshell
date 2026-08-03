"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { CopyableValue } from "@/components/copyable-value";
import {
  DataTable,
  DataTableColumnHeader,
} from "@/components/data-table";
import { AgentIdentityAvatar } from "@/components/identity-avatar";
import { StatusBadge } from "@/components/status-badge";
import type { CloudAgent } from "@/lib/cloud-api";

export function AgentList({ agents }: { agents: CloudAgent[] }) {
  const columns = useMemo<ColumnDef<CloudAgent>[]>(
    () => [
      {
        id: "search",
        accessorFn: (agent) => `${agent.name} ${agent.id} ${agent.kind}`,
      },
      {
        accessorKey: "name",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Agent" />
        ),
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-3">
            <AgentIdentityAvatar
              name={row.original.name}
              className="size-8"
            />
            <div className="min-w-0">
              <p className="truncate font-medium">{row.original.name}</p>
              <CopyableValue
                value={row.original.id}
                label={`${row.original.name} ID`}
                className="font-mono text-xs text-muted-foreground"
              />
            </div>
          </div>
        ),
      },
      {
        accessorKey: "kind",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Type" />
        ),
        cell: ({ row }) => (
          <span className="capitalize">{row.original.kind}</span>
        ),
        filterFn: "equals",
      },
      {
        accessorKey: "status",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        filterFn: "equals",
      },
      {
        accessorKey: "parentAgentId",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Parent" />
        ),
        cell: ({ row }) =>
          row.original.parentAgentId ? (
            <CopyableValue
              value={row.original.parentAgentId}
              label="Parent ID"
              className="font-mono text-xs text-muted-foreground"
            />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
    ],
    [],
  );

  return (
    <DataTable
      columns={columns}
      data={agents}
      searchColumn="search"
      searchPlaceholder="Search agents"
      emptyMessage="No Agents match these filters."
      filters={[
        {
          columnId: "kind",
          label: "All types",
          options: [
            { label: "Independent", value: "independent" },
            { label: "Managed", value: "managed" },
          ],
        },
        {
          columnId: "status",
          label: "All statuses",
          options: [
            { label: "Active", value: "active" },
            { label: "Disabled", value: "disabled" },
          ],
        },
      ]}
    />
  );
}
