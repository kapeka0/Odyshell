"use client";

import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { SessionList } from "@/components/session-list";

export default function SessionsPage() {
  const { state } = useDashboard();
  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Human supervision"
        title="Sessions"
        description="Observe agent work and intervene only when policy requires a human decision."
      />
      {state.status === "ready" ? (
        <SessionList />
      ) : (
        <DashboardStateNotice state={state} />
      )}
    </DashboardPage>
  );
}
