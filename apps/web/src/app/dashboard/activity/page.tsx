import type { Metadata } from "next";
import { ControlEventList } from "@/components/control-event-list";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { dashboardState } from "@/lib/dashboard-context";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage() {
  const state = await dashboardState();

  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Workspace"
        title="Activity"
        description="Review who changed access and which control actions were accepted."
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
