"use client";

import { useDashboard } from "@/components/dashboard-provider";
import { DashboardStateNotice } from "@/components/dashboard-state";
import { WorkspaceCanvas } from "@/components/workspace-canvas";

export default function DashboardPage() {
  const { state } = useDashboard();

  return (
    <div className="flex min-h-[calc(100svh-3.5rem)] flex-1 flex-col gap-4 p-4 md:p-6">
      {state.status === "ready" ? <WorkspaceCanvas context={state.context} /> : <DashboardStateNotice state={state} />}
    </div>
  );
}
