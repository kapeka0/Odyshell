"use client";

import { useAuth, useOrganization } from "@clerk/nextjs";
import { ShieldCheckIcon } from "lucide-react";
import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { WorkspaceIdentityAvatar } from "@/components/identity-avatar";
import { EventSinkSettings } from "@/components/event-sink-settings";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function WorkspaceSettingsPage() {
  const { state } = useDashboard();
  const { organization } = useOrganization();
  const { orgRole } = useAuth();

  return (
    <DashboardPage>
      <DashboardPageHeader
        title="Settings"
      />
      {state.status !== "ready" ? (
        <DashboardStateNotice state={state} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Workspace</CardTitle>
              <CardDescription>Identity and role.</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-4">
              <WorkspaceIdentityAvatar
                identity={organization?.id ?? state.context.organization.id}
                name={state.context.workspace.name}
                className="size-12"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {state.context.workspace.name}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {state.context.workspace.id}
                </p>
              </div>
              <Badge variant="outline">
                {orgRole === "org:admin" ? "Admin" : "Member"}
              </Badge>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Plan</CardTitle>
              <CardDescription>{state.context.plan.id} usage.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
              <Limit
                label="Machines"
                used={state.context.usage.machines}
                limit={state.context.plan.machineLimit}
              />
              <Limit
                label="Agents"
                used={state.context.usage.activeAgents}
                limit={state.context.plan.activeAgentLimit}
              />
              <Limit
                label="Workspaces"
                used={state.context.usage.workspaces}
                limit={state.context.plan.workspaceLimit}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Logging policy</CardTitle>
              <CardDescription>Control Event detail.</CardDescription>
            </CardHeader>
            <CardContent className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border">
                <ShieldCheckIcon aria-hidden="true" className="size-4" />
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">Privacy-minimal</p>
                  <Badge variant="outline">Default</Badge>
                </div>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Commands, arguments, paths, file contents, stdout and stderr
                  are never stored in Control Events. Encrypted detailed
                  policies will be introduced in a later plan.
                </p>
              </div>
            </CardContent>
          </Card>
          {orgRole === "org:admin" ? <EventSinkSettings /> : null}
        </>
      )}
    </DashboardPage>
  );
}

function Limit({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number;
}) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg tabular-nums">
        {used} / {limit}
      </p>
    </div>
  );
}
