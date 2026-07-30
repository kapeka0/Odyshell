"use client";

import { AgentAccessManager } from "@/components/agent-access-manager";
import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";

export default function AgentAccessPage() {
  const { state } = useDashboard();

  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Workspace"
        title="Agent access"
        description="Grant only the machines, capabilities and lifetime an agent needs."
      />
      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <AgentAccessManager
          machines={state.context.machines}
          accesses={state.context.agentAccess ?? []}
          atLimit={
            state.context.usage.activeAgents >= state.context.plan.activeAgentLimit
          }
        />
      )}
    </DashboardPage>
  );
}
