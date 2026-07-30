import type { Metadata } from "next";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { EnrollMachine } from "@/components/enroll-machine";
import { MachineList } from "@/components/machine-list";
import { publicServerUrl } from "@/lib/cloud-api";
import { dashboardState } from "@/lib/dashboard-context";

export const metadata: Metadata = { title: "Machines" };

export default async function MachinesPage() {
  const state = await dashboardState();

  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Workspace"
        title="Machines"
        description="Manage the clients that keep an outbound connection to Odyshell."
      />
      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.65fr)]">
          <MachineList machines={state.context.machines} />
          <EnrollMachine
            serverUrl={publicServerUrl()}
            atLimit={state.context.usage.machines >= state.context.plan.machineLimit}
          />
        </section>
      )}
    </DashboardPage>
  );
}
