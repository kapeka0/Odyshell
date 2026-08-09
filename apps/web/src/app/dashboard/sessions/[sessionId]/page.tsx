"use client";

import Link from "next/link";
import { use } from "react";
import { useDashboard } from "@/components/dashboard-provider";
import { DashboardPage, DashboardPageHeader, DashboardStateNotice } from "@/components/dashboard-state";
import { SessionTimeline } from "@/components/session-timeline";
import { buttonVariants } from "@/components/ui/button";

export default function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const { state } = useDashboard();
  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Session timeline"
        title="Trace"
        description="Commands, Machine output and authority decisions in chronological order."
        action={<Link href="/dashboard/sessions" className={buttonVariants({ variant: "outline" })}>All Sessions</Link>}
      />
      {state.status === "ready" ? <SessionTimeline sessionId={sessionId} timeZone={state.context.userPreferences.timeZone} /> : <DashboardStateNotice state={state} />}
    </DashboardPage>
  );
}
