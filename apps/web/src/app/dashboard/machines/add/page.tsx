"use client";

import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { EnrollMachine } from "@/components/enroll-machine";

export default function AddMachinePage() {
  const { state, serverUrl } = useDashboard();

  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Machines"
        title="Connect a machine"
        description="The Client connects outbound and keeps every Odyshell server identity isolated."
      />
      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <EnrollMachine
          serverUrl={serverUrl}
          atLimit={
            state.context.usage.machines >= state.context.plan.machineLimit
          }
        />
      )}
    </DashboardPage>
  );
}
