import { auth } from "@clerk/nextjs/server";
import { ActivityIcon, CircleDotIcon, CpuIcon, KeyRoundIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { AgentAccessManager } from "@/components/agent-access-manager";
import { AppShell } from "@/components/app-shell";
import { ControlEventList } from "@/components/control-event-list";
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
    <AppShell title={context?.organization.name ?? "Workspace"}>
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-4 py-8 md:px-8 md:py-10">
        <section
          id="overview"
          className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"
        >
          <div>
            <p className="text-sm text-muted-foreground">Workspace overview</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">
              {context?.organization.name ?? "Your workspace"}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Connect machines and grant agents only the access they need.
            </p>
          </div>
          {context ? <Badge variant="outline">{context.organization.plan} plan</Badge> : null}
        </section>

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
            <section className="grid gap-3 sm:grid-cols-3" aria-label="Workspace usage">
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

            <section
              id="machines"
              className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(20rem,0.7fr)]"
            >
              <MachineList machines={context.machines} />
              <EnrollMachine
                serverUrl={publicServerUrl()}
                atLimit={context.usage.machines >= context.plan.machineLimit}
              />
            </section>

            <section id="agent-access">
              <AgentAccessManager
                machines={context.machines}
                accesses={context.agentAccess ?? []}
                atLimit={
                  context.usage.activeAgents >= context.plan.activeAgentLimit
                }
              />
            </section>

            <section id="control-events">
              <ControlEventList
                events={context.controlEvents ?? []}
                machines={context.machines}
                accesses={context.agentAccess ?? []}
              />
            </section>
          </>
        ) : null}
      </div>
    </AppShell>
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
