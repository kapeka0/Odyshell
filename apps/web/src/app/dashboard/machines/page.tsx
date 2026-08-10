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

  return (
    <DashboardPage>
      <DashboardPageHeader title="Machines" />
      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <MachineList machines={state.context.machines} />
      )}
    </DashboardPage>
  );
}
