import { auth } from "@clerk/nextjs/server";
import { ActivityIcon, CircleDotIcon, CpuIcon, KeyRoundIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/dashboard-header";
import { EnrollMachine } from "@/components/enroll-machine";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { currentCloudIdentity } from "@/lib/clerk-identity";
import { CloudApiError, cloudRequest, publicServerUrl, type CloudContext } from "@/lib/cloud-api";

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
              Machines, capacity and access entry points in one place.
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
                label="Agent tokens"
                value={`${context.usage.activeAgents} / ${context.plan.activeAgentLimit}`}
                note="Creation comes next"
              />
            </section>

            <section className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
              <Card>
                <CardHeader>
                  <CardTitle>Machines</CardTitle>
                  <CardDescription>Clients enrolled in this workspace.</CardDescription>
                  <CardAction>
                    <Badge variant={context.machines.some((machine) => machine.online) ? "default" : "outline"}>
                      {context.machines.filter((machine) => machine.online).length} online
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  {context.machines.length === 0 ? (
                    <div className="grid min-h-48 place-items-center border-y text-center">
                      <div>
                        <p className="font-heading font-medium">No machines yet</p>
                        <p className="mt-2 text-sm text-muted-foreground">
                          Generate the command beside this table to connect one.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Machine</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="hidden sm:table-cell">Last seen</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {context.machines.map((machine) => (
                            <TableRow key={machine.id}>
                              <TableCell className="font-heading font-medium">{machine.name}</TableCell>
                              <TableCell>
                                <span className="inline-flex items-center gap-2">
                                  <span
                                    className={machine.online ? "size-2 rounded-full bg-[var(--color-success)]" : "size-2 rounded-full bg-muted-foreground"}
                                    aria-hidden="true"
                                  />
                                  {machine.online ? "Online" : machine.status}
                                </span>
                              </TableCell>
                              <TableCell className="hidden text-muted-foreground sm:table-cell">
                                {machine.lastSeenAt
                                  ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(machine.lastSeenAt))
                                  : "Never"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
              <EnrollMachine
                serverUrl={publicServerUrl()}
                atLimit={context.usage.machines >= context.plan.machineLimit}
              />
            </section>
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
  note,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note?: string;
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
      {note ? <CardContent className="text-xs text-muted-foreground">{note}</CardContent> : null}
    </Card>
  );
}
