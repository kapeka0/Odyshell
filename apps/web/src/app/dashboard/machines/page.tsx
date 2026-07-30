"use client";

import { PlusIcon } from "lucide-react";
import Link from "next/link";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { MachineList } from "@/components/machine-list";
import { useDashboard } from "@/components/dashboard-provider";
import { Button, buttonVariants } from "@/components/ui/button";

export default function MachinesPage() {
  const { state } = useDashboard();
  const atLimit =
    state.status === "ready" &&
    state.context.usage.machines >= state.context.plan.machineLimit;

  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Workspace"
        title="Machines"
        action={
          state.status === "ready" ? (
            atLimit ? (
              <Button type="button" disabled>
                Machine limit reached
              </Button>
            ) : (
              <Link
                href="/dashboard/machines/add"
                className={buttonVariants()}
              >
                <PlusIcon data-icon="inline-start" />
                Add machine
              </Link>
            )
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
