"use client";

import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { TaskList } from "@/components/task-list";

export default function TasksPage() {
  const { state } = useDashboard();
  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Human supervision"
        title="Tasks"
        description="Observe agent work and intervene only when policy requires a human decision."
      />
      {state.status === "ready" ? (
        <TaskList />
      ) : (
        <DashboardStateNotice state={state} />
      )}
    </DashboardPage>
  );
}
