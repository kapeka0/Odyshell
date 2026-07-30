import type { Metadata } from "next";
import { AgentAccessManager } from "@/components/agent-access-manager";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { dashboardState } from "@/lib/dashboard-context";

export const metadata: Metadata = { title: "Agent access" };

export default async function AgentAccessPage() {
  const state = await dashboardState();

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
