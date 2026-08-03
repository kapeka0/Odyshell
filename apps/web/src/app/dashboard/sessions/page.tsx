"use client";

import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { SessionList } from "@/components/session-list";
import { CreateSessionSheet } from "@/components/create-session-sheet";

export default function SessionsPage() {
  const { state } = useDashboard();
  return (
    <DashboardPage>
      <DashboardPageHeader title="Sessions" action={<CreateSessionSheet />} />
      {state.status === "ready" ? (
        <SessionList
          sessions={state.context.sessions ?? []}
          requests={state.context.sessionRequests ?? []}
        />
      ) : (
        <DashboardStateNotice state={state} />
      )}
    </DashboardPage>
  );
}
