"use client";

import { ActivityIcon, CircleDotIcon, CpuIcon, KeyRoundIcon } from "lucide-react";
import Link from "next/link";
import {
  DashboardPage as DashboardPageFrame,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useDashboard } from "@/components/dashboard-provider";

export default function OverviewPage() {
  const { state } = useDashboard();

  return (
    <DashboardPageFrame>
      <DashboardPageHeader
        eyebrow="Workspace overview"
        title={state.status === "ready" ? state.context.organization.name : "Your workspace"}
        description="See connected capacity at a glance, then go directly to the task you need."
        action={
          state.status === "ready" ? (
            <Badge variant="outline">{state.context.organization.plan} plan</Badge>
          ) : undefined
        }
      />

      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-3" aria-label="Workspace usage">
            <Metric
              icon={<CpuIcon />}
              label="Machines"
              value={`${state.context.usage.machines} / ${state.context.plan.machineLimit}`}
            />
            <Metric
              icon={<CircleDotIcon />}
              label="Online now"
              value={String(
                state.context.machines.filter((machine) => machine.online).length,
              )}
            />
            <Metric
              icon={<ActivityIcon />}
              label="Agent access"
              value={`${state.context.usage.activeAgents} / ${state.context.plan.activeAgentLimit}`}
            />
          </section>

          <section className="grid gap-4 md:grid-cols-3" aria-label="Workspace tasks">
            <TaskCard
              icon={<CpuIcon />}
              title="Machines"
              description="Connect, inspect and remove machines."
              href="/dashboard/machines"
            />
            <TaskCard
              icon={<KeyRoundIcon />}
              title="Agent access"
              description="Issue scoped access that expires automatically."
              href="/dashboard/access"
            />
            <TaskCard
              icon={<ActivityIcon />}
              title="Activity"
              description="Review control events without recording secrets."
              href="/dashboard/activity"
            />
          </section>
        </>
      )}
    </DashboardPageFrame>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <span aria-hidden="true">{icon}</span>
          {label}
        </CardDescription>
        <CardTitle className="mt-2 text-2xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

function TaskCard({
  icon,
  title,
  description,
  href,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Card>
      <CardHeader>
        <span aria-hidden="true" className="text-muted-foreground">{icon}</span>
        <CardTitle className="mt-5">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent />
      <CardFooter>
        <Link
          href={href}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "whitespace-nowrap")}
        >
          Open
        </Link>
      </CardFooter>
    </Card>
  );
}
