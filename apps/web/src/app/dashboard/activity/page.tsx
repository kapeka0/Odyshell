"use client";

import { ControlEventList } from "@/components/control-event-list";
import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";

export default function ActivityPage() {
  const { state } = useDashboard();

  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Workspace"
        title="Activity"
      />
      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <ControlEventList
          events={state.context.controlEvents ?? []}
          machines={state.context.machines}
          accesses={state.context.agentAccess ?? []}
        />
      )}
    </DashboardPage>
  );
}
