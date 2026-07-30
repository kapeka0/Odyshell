"use client";

import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { EnrollMachine } from "@/components/enroll-machine";
import { MachineList } from "@/components/machine-list";
import { useDashboard } from "@/components/dashboard-provider";

export default function MachinesPage() {
  const { state, serverUrl } = useDashboard();

  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Workspace"
        title="Machines"
        description="Manage the clients that keep an outbound connection to Odyshell."
        action={
          state.status === "ready" ? (
            <EnrollMachine
              serverUrl={serverUrl}
              atLimit={
                state.context.usage.machines >=
                state.context.plan.machineLimit
              }
            />
          ) : undefined
        }
      />
      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <MachineList machines={state.context.machines} />
      )}
    </DashboardPage>
  );
}
