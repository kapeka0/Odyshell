"use client";

import Link from "next/link";
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
  const [savingDetails, setSavingDetails] = useState(false);
  const [savingLogging, setSavingLogging] = useState(false);
  const [confirmDiagnostic, setConfirmDiagnostic] = useState(false);

  if (state.status !== "ready") {
    return (
      <DashboardPage>
        <DashboardPageHeader title="Settings" />
        <DashboardStateNotice state={state} />
      </DashboardPage>
    );
  }

  const admin = state.context.currentMemberRole === "owner" || state.context.currentMemberRole === "admin";
  const workspace = state.context.workspace;
  const detailsDirty =
    name.trim() !== workspace.name ||
    avatarSeed !== workspace.avatarSeed;
  const loggingDirty = loggingLevel !== workspace.loggingLevel;

  async function saveDetails() {
    if (!admin || !detailsDirty || savingDetails) return;
    const previous = workspace;
    const nextName = name.trim();
    setSavingDetails(true);
    optimisticallyUpdate((context) => ({
      ...context,
      workspace: { ...context.workspace, name: nextName, avatarSeed },
    }));
    try {
      const response = await fetch("/api/workspace-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          section: "details",
          name: nextName,
          avatarSeed,
        }),
      });
      if (!response.ok) throw new Error("workspace_details_not_saved");
      await refresh();
      toast.add({ title: "Workspace saved", type: "success" });
    } catch {
      optimisticallyUpdate((context) => ({
        ...context,
        workspace: {
          ...context.workspace,
          name: previous.name,
          avatarSeed: previous.avatarSeed,
        },
      }));
      toast.add({
        title: "Workspace was not saved",
        description: "Your previous settings were restored.",
        type: "error",
      });
    } finally {
      setSavingDetails(false);
    }
  }

  async function saveLogging(diagnosticConfirmed = false) {
    if (!admin || !loggingDirty || savingLogging) return;
    if (
      loggingLevel === "diagnostic" &&
      workspace.loggingLevel !== "diagnostic" &&
      !diagnosticConfirmed
    ) {
      setConfirmDiagnostic(true);
      return;
    }
    const previous = workspace;
    setSavingLogging(true);
    setConfirmDiagnostic(false);
    optimisticallyUpdate((context) => ({
      ...context,
      workspace: { ...context.workspace, loggingLevel },
    }));
    try {
      const response = await fetch("/api/workspace-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          section: "logging",
          loggingLevel,
        }),
      });
      if (!response.ok) throw new Error("workspace_logging_not_saved");
      await refresh();
      toast.add({ title: "Logging saved", type: "success" });
    } catch {
      optimisticallyUpdate((context) => ({
        ...context,
        workspace: {
          ...context.workspace,
          loggingLevel: previous.loggingLevel,
        },
      }));
      toast.add({
        title: "Settings were not saved",
        description: "Your previous settings were restored.",
        type: "error",
      });
    } finally {
      setSavingLogging(false);
    }
  }

  function cancelDetails() {
    setName(workspace.name);
    setAvatarSeed(workspace.avatarSeed);
  }

  function cancelLogging() {
    setLoggingLevel(workspace.loggingLevel);
  }

  return (
    <DashboardPage>
      <DashboardPageHeader title="Settings" />

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-heading text-lg font-medium">Organization details</h2>
          <p className="text-sm text-muted-foreground">Identity and plan.</p>
        </div>
        <Card>
          <CardContent className="p-0">
            <FieldGroup className="gap-0">
              <Field orientation="responsive" className="p-4">
                <FieldContent>
                  <FieldTitle>Avatar</FieldTitle>
                  <FieldDescription>Identifies this organization across Odyshell.</FieldDescription>
                </FieldContent>
                <div className="flex w-full items-center justify-end gap-3 @md/field-group:w-auto">
                  <WorkspaceIdentityAvatar identity={avatarSeed} name={name || workspace.name} className="size-10" />
                  {admin ? (
                    <Button variant="outline" onClick={() => setAvatarSeed(crypto.randomUUID())}>Regenerate</Button>
                  ) : null}
                </div>
              </Field>
              <Field orientation="responsive" className="p-4">
                <FieldContent>
                  <FieldLabel htmlFor="workspace-name">Name</FieldLabel>
                  <FieldDescription>Shown to members and Agents.</FieldDescription>
                </FieldContent>
                <Input id="workspace-name" name="workspace-name" autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} className="w-full @md/field-group:max-w-md" disabled={!admin} />
              </Field>
              <ReadOnlyRow label="Slug" description="Stable organization handle." value={workspace.slug} />
              <ReadOnlyRow label="Plan" description="Current plan and included limits." value={state.context.plan.id} badge />
              <ReadOnlyRow label="Machines" description="Connected machine allowance." value={`${state.context.usage.machines} / ${state.context.plan.machineLimit}`} />
              <ReadOnlyRow label="Agents" description="Active Agent allowance." value={`${state.context.usage.activeAgents} / ${state.context.plan.activeAgentLimit}`} />
            </FieldGroup>
          </CardContent>
          {admin ? (
            <CardFooter className="justify-end gap-2 border-0 bg-card">
              <Button variant="outline" disabled={!detailsDirty || savingDetails} onClick={cancelDetails}>Cancel</Button>
              <Button disabled={!detailsDirty || savingDetails || !name.trim()} onClick={() => void saveDetails()}>
                {savingDetails ? <Spinner data-icon="inline-start" /> : null}
                Save
              </Button>
            </CardFooter>
          ) : null}
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
          <CardContent className="p-0">
            <FieldGroup className="gap-0">
              <Field orientation="responsive" className="items-start p-4">
                <FieldContent>
                  <FieldTitle>Timeline detail</FieldTitle>
                  <FieldDescription>
                    Captured when each new Session is requested. <Link href="/docs/sessions#timeline">Learn more</Link>
                  </FieldDescription>
                </FieldContent>
                <RadioGroup
                  value={loggingLevel}
                  onValueChange={(value) => setLoggingLevel(value as LoggingLevel)}
                  disabled={!admin}
                  className="w-full gap-0 @md/field-group:max-w-lg"
                >
                  {loggingOptions.map((option) => (
                    <Field key={option.value} orientation="horizontal" className="py-2">
                      <RadioGroupItem value={option.value} id={`logging-${option.value}`} />
                      <FieldContent>
                        <FieldLabel htmlFor={`logging-${option.value}`}>{option.label}</FieldLabel>
                        <FieldDescription>{option.description}</FieldDescription>
                      </FieldContent>
                    </Field>
                  ))}
                </RadioGroup>
              </Field>
            </FieldGroup>
          </CardContent>
          {admin ? (
            <CardFooter className="justify-end gap-2 border-0 bg-card">
              <Button variant="outline" disabled={!loggingDirty || savingLogging} onClick={cancelLogging}>Cancel</Button>
              <Button disabled={!loggingDirty || savingLogging} onClick={() => void saveLogging(false)}>
                {savingLogging ? <Spinner data-icon="inline-start" /> : null}
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
              Commands, paths, stdout and stderr may contain secrets. This applies only to new Sessions. <Link href="/docs/sessions#timeline">Review the logging levels.</Link>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void saveLogging(true)}>Enable</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardPage>
  );
}

function ReadOnlyRow({ label, description, value, badge = false }: { label: string; description: string; value: string; badge?: boolean }) {
  return (
    <Field orientation="responsive" className="p-4">
      <FieldContent>
        <FieldTitle>{label}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      {badge ? <Badge variant="outline" className="capitalize">{value}</Badge> : <p className="font-mono text-sm tabular-nums text-muted-foreground">{value}</p>}
    </Field>
  );
}
