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
        title="Activity"
        description={
          state.status === "ready"
            ? `Self-hosted · ${state.context.auditRetentionDays}-day retention`
            : undefined
        }
      />
      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <ControlEventList
          events={state.context.controlEvents ?? []}
          machines={state.context.machines}
          agents={state.context.agents}
          members={state.context.members}
          retentionDays={state.context.auditRetentionDays}
        />
      )}
    </DashboardPage>
  );
}
