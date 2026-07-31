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
            ? `${planLabel(state.context.plan.id)} · ${state.context.plan.controlEventRetentionDays}-day retention`
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
          retentionDays={state.context.plan.controlEventRetentionDays}
        />
      )}
    </DashboardPage>
  );
}

function planLabel(planId: "free" | "team" | "scale"): string {
  return `${planId[0]!.toUpperCase()}${planId.slice(1)} plan`;
}
