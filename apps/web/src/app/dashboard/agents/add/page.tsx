"use client";

import { CreateAgentAccess } from "@/components/create-agent-access";
import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";

export default function AddAgentPage() {
  const { state, serverUrl } = useDashboard();

  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Agents"
        title="Create agent"
        description="Grant temporary access to specific machines and operations."
      />
      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <CreateAgentAccess
          machines={state.context.machines}
          serverUrl={serverUrl}
          atLimit={
            state.context.usage.activeAgents >=
            state.context.plan.activeAgentLimit
          }
        />
      )}
    </DashboardPage>
  );
}
