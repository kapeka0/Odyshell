import { auth } from "@clerk/nextjs/server";
import { ActivityIcon, CircleDotIcon, CpuIcon, KeyRoundIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { AgentAccessManager } from "@/components/agent-access-manager";
import { ControlEventList } from "@/components/control-event-list";
import { DashboardHeader } from "@/components/dashboard-header";
import { EnrollMachine } from "@/components/enroll-machine";
import { MachineList } from "@/components/machine-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { currentCloudIdentity } from "@/lib/clerk-identity";
import {
  CloudApiError,
  cloudRequest,
  publicServerUrl,
  type CloudContext,
} from "@/lib/cloud-api";

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=%2Fdashboard");
  const identity = await currentCloudIdentity();
  let context: CloudContext | null = null;
  let error: string | null = null;
  if (identity) {
    try {
      context = await cloudRequest<CloudContext>("/v1/internal/cloud/context", identity);
    } catch (reason) {
      error =
        reason instanceof CloudApiError
          ? reason.code
          : "Odyshell server is unavailable";
    }
  }

  return (
    <>
      <DashboardHeader />
      <main className="page-shell space-y-10 py-10 md:py-14">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-primary">Control plane</p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight">
              {context?.organization.name ?? "Your workspace"}
            </h1>
            <p className="mt-3 text-muted-foreground">
              Connect machines and grant agents only the access they need.
            </p>
          </div>
          {context ? <Badge variant="outline">{context.organization.plan} plan</Badge> : null}
        </div>

        {!identity ? (
          <Alert>
            <KeyRoundIcon />
            <AlertTitle>Select an organization</AlertTitle>
            <AlertDescription>
              Choose or create an organization above to create your Odyshell workspace.
            </AlertDescription>
          </Alert>
        ) : error ? (
          <Alert variant="destructive">
            <AlertTitle>Control plane unavailable</AlertTitle>
            <AlertDescription>
              {error}. Check the web-to-server configuration and try again.
            </AlertDescription>
          </Alert>
        ) : context ? (
          <>
            <section className="grid gap-4 sm:grid-cols-3" aria-label="Workspace usage">
              <Metric
                icon={<CpuIcon />}
                label="Machines"
                value={`${context.usage.machines} / ${context.plan.machineLimit}`}
              />
              <Metric
                icon={<CircleDotIcon />}
                label="Online now"
                value={String(context.machines.filter((machine) => machine.online).length)}
              />
              <Metric
                icon={<ActivityIcon />}
                label="Agent access"
                value={`${context.usage.activeAgents} / ${context.plan.activeAgentLimit}`}
              />
            </section>

            <section className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
              <MachineList machines={context.machines} />
              <EnrollMachine
                serverUrl={publicServerUrl()}
                atLimit={context.usage.machines >= context.plan.machineLimit}
              />
            </section>

            <AgentAccessManager
              machines={context.machines}
              accesses={context.agentAccess ?? []}
              atLimit={
                context.usage.activeAgents >= context.plan.activeAgentLimit
              }
            />

            <ControlEventList
              events={context.controlEvents ?? []}
              machines={context.machines}
              accesses={context.agentAccess ?? []}
            />
          </>
        ) : null}
      </main>
    </>
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
          {icon}
          {label}
        </CardDescription>
        <CardTitle className="mt-2 text-2xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}
