"use client";

import { AgentList } from "@/components/agent-list";
import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";

export default function AgentsPage() {
  const { state } = useDashboard();
  return (
    <DashboardPage>
      <DashboardPageHeader title="Agents" />
      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <AgentList
          agents={state.context.agents}
          canDelete={state.context.currentMemberRole === "admin"}
        />
      )}
    </DashboardPage>
  );
}
