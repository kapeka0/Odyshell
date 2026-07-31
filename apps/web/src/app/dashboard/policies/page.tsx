"use client";

import { AgentPolicyList } from "@/components/agent-policy-list";
import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";

export default function PoliciesPage() {
  const { state } = useDashboard();
  return (
    <DashboardPage>
      <DashboardPageHeader title="Policies" />
      {state.status === "ready" ? (
        <AgentPolicyList
          policies={state.context.policies ?? []}
          agents={state.context.agents ?? []}
        />
      ) : (
        <DashboardStateNotice state={state} />
      )}
    </DashboardPage>
  );
}
