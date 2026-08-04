"use client";

import { useAuth } from "@clerk/nextjs";
import { useState } from "react";
import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { EventSinkSettings } from "@/components/event-sink-settings";
import { WorkspaceIdentityAvatar } from "@/components/identity-avatar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import type { CloudContext } from "@/lib/cloud-api";

type LoggingLevel = CloudContext["workspace"]["loggingLevel"];

const loggingOptions: Array<{
  value: LoggingLevel;
  label: string;
  description: string;
}> = [
  {
    value: "privacy-minimal",
    label: "Privacy-minimal",
    description: "Lifecycle and status only.",
  },
  {
    value: "operational",
    label: "Operational",
    description: "Commands, paths and output with automatic secret redaction.",
  },
  {
    value: "diagnostic",
    label: "Diagnostic",
    description: "Complete details that may contain secrets.",
  },
];

export default function WorkspaceSettingsPage() {
  const { state, optimisticallyUpdate, refresh } = useDashboard();
  const { orgRole } = useAuth();
  const [name, setName] = useState(
    state.status === "ready" ? state.context.workspace.name : "",
  );
  const [avatarSeed, setAvatarSeed] = useState(
    state.status === "ready" ? state.context.workspace.avatarSeed : "",
  );
  const [loggingLevel, setLoggingLevel] = useState<LoggingLevel>(
    state.status === "ready"
      ? state.context.workspace.loggingLevel
      : "privacy-minimal",
  );
  const [saving, setSaving] = useState(false);
  const [confirmDiagnostic, setConfirmDiagnostic] = useState(false);

  if (state.status !== "ready") {
    return (
      <DashboardPage>
        <DashboardPageHeader title="Settings" />
        <DashboardStateNotice state={state} />
      </DashboardPage>
    );
  }

  const admin = orgRole === "org:admin";
  const workspace = state.context.workspace;
  const dirty =
    name.trim() !== workspace.name ||
    avatarSeed !== workspace.avatarSeed ||
    loggingLevel !== workspace.loggingLevel;

  async function save(diagnosticConfirmed = false) {
    if (!admin || !dirty || saving) return;
    if (
      loggingLevel === "diagnostic" &&
      workspace.loggingLevel !== "diagnostic" &&
      !diagnosticConfirmed
    ) {
      setConfirmDiagnostic(true);
      return;
    }
    const previous = workspace;
    const next = { ...workspace, name: name.trim(), avatarSeed, loggingLevel };
    setSaving(true);
    setConfirmDiagnostic(false);
    optimisticallyUpdate((context) => ({ ...context, workspace: next }));
    try {
      const response = await fetch("/api/workspace-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: next.name,
          avatarSeed: next.avatarSeed,
          loggingLevel: next.loggingLevel,
        }),
      });
      if (!response.ok) throw new Error("workspace_settings_not_saved");
      await refresh();
      toast.add({ title: "Settings saved", type: "success" });
    } catch {
      optimisticallyUpdate((context) => ({ ...context, workspace: previous }));
      toast.add({
        title: "Settings were not saved",
        description: "Your previous settings were restored.",
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setName(workspace.name);
    setAvatarSeed(workspace.avatarSeed);
    setLoggingLevel(workspace.loggingLevel);
  }

  return (
    <DashboardPage>
      <DashboardPageHeader title="Settings" />

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-heading text-lg font-medium">Workspace details</h2>
          <p className="text-sm text-muted-foreground">Identity and plan.</p>
        </div>
        <Card>
          <CardContent className="p-0">
            <FieldGroup className="gap-0">
              <Field orientation="responsive" className="border-b p-4">
                <FieldContent>
                  <FieldTitle>Avatar</FieldTitle>
                  <FieldDescription>Generated for this workspace.</FieldDescription>
                </FieldContent>
                <div className="flex w-full items-center justify-end gap-3 @md/field-group:w-auto">
                  <WorkspaceIdentityAvatar identity={avatarSeed} name={name || workspace.name} className="size-10" />
                  {admin ? (
                    <Button variant="outline" onClick={() => setAvatarSeed(crypto.randomUUID())}>Regenerate</Button>
                  ) : null}
                </div>
              </Field>
              <Field orientation="responsive" className="border-b p-4">
                <FieldContent><FieldLabel htmlFor="workspace-name">Name</FieldLabel></FieldContent>
                <Input id="workspace-name" value={name} onChange={(event) => setName(event.target.value)} className="w-full @md/field-group:max-w-md" disabled={!admin} />
              </Field>
              <ReadOnlyRow label="Slug" value={workspace.slug} />
              <ReadOnlyRow label="Plan" value={state.context.plan.id} badge />
              <ReadOnlyRow label="Machines" value={`${state.context.usage.machines} / ${state.context.plan.machineLimit}`} />
              <ReadOnlyRow label="Agents" value={`${state.context.usage.activeAgents} / ${state.context.plan.activeAgentLimit}`} last />
            </FieldGroup>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-heading text-lg font-medium">Logging</h2>
          <p className="text-sm text-muted-foreground">Timeline detail for new sessions.</p>
        </div>
        <Card>
          <CardHeader className="sr-only">
            <CardTitle>Logging</CardTitle>
            <CardDescription>Timeline detail for new sessions.</CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup
              value={loggingLevel}
              onValueChange={(value) => setLoggingLevel(value as LoggingLevel)}
              disabled={!admin}
              className="gap-0"
            >
              {loggingOptions.map((option, index) => (
                <Field key={option.value} orientation="horizontal" className={index < loggingOptions.length - 1 ? "border-b py-4" : "pt-4"}>
                  <RadioGroupItem value={option.value} id={`logging-${option.value}`} />
                  <FieldContent>
                    <FieldLabel htmlFor={`logging-${option.value}`}>{option.label}</FieldLabel>
                    <FieldDescription>{option.description}</FieldDescription>
                  </FieldContent>
                </Field>
              ))}
            </RadioGroup>
          </CardContent>
          {admin ? (
            <CardFooter className="justify-end gap-2">
              <Button variant="outline" disabled={!dirty || saving} onClick={cancel}>Cancel</Button>
              <Button disabled={!dirty || saving || !name.trim()} onClick={() => void save(false)}>
                {saving ? <Spinner data-icon="inline-start" /> : null}
                Save
              </Button>
            </CardFooter>
          ) : null}
        </Card>
      </section>

      {admin ? <EventSinkSettings /> : null}

      <AlertDialog open={confirmDiagnostic} onOpenChange={setConfirmDiagnostic}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable Diagnostic logging?</AlertDialogTitle>
            <AlertDialogDescription>
              Commands, paths, stdout and stderr may contain secrets. This applies only to new sessions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void save(true)}>Enable</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardPage>
  );
}

function ReadOnlyRow({ label, value, badge = false, last = false }: { label: string; value: string; badge?: boolean; last?: boolean }) {
  return (
    <Field orientation="horizontal" className={last ? "p-4" : "border-b p-4"}>
      <FieldTitle>{label}</FieldTitle>
      {badge ? <Badge variant="outline" className="capitalize">{value}</Badge> : <p className="font-mono text-sm tabular-nums text-muted-foreground">{value}</p>}
    </Field>
  );
}
