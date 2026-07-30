"use client";

import Link from "next/link";
import { AgentAccessManager } from "@/components/agent-access-manager";
import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";

export default function AgentsPage() {
  const { state } = useDashboard();
  const atLimit =
    state.status === "ready" &&
    state.context.usage.activeAgents >= state.context.plan.activeAgentLimit;

  return (
    <DashboardPage>
      <DashboardPageHeader
        title="Agents"
        action={
          state.status === "ready" ? (
            atLimit ? (
              <Button type="button" disabled>
                Limit reached
              </Button>
            ) : (
              <Link
                href="/dashboard/agents/add"
                className={buttonVariants()}
              >
                <PlusIcon aria-hidden="true" data-icon="inline-start" />
                Add
              </Link>
            )
          ) : undefined
        }
      />
      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <AgentAccessManager
          machines={state.context.machines}
          accesses={state.context.agentAccess ?? []}
        />
      )}
    </DashboardPage>
  );
}
