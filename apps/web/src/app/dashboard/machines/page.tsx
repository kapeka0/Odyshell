"use client";

import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { MachineList } from "@/components/machine-list";
import { useDashboard } from "@/components/dashboard-provider";

export default function MachinesPage() {
  const { state } = useDashboard();
  const atLimit =
    state.status === "ready" &&
    state.context.usage.machines >= state.context.plan.machineLimit;

  return (
    <DashboardPage>
      <DashboardPageHeader title="Machines" />
      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <MachineList machines={state.context.machines} atLimit={atLimit} />
      )}
    </DashboardPage>
  );
}
