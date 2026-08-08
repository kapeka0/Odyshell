"use client";

import { useState } from "react";
import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { OrganizationIdentityAvatar } from "@/components/identity-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
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
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";

export default function OrganizationSettingsPage() {
  const { state, optimisticallyUpdate, refresh } = useDashboard();
  const [name, setName] = useState(
    state.status === "ready" ? state.context.organization.name : "",
  );
  const [avatarSeed, setAvatarSeed] = useState(
    state.status === "ready" ? state.context.organization.avatarSeed : "",
  );
  const [savingDetails, setSavingDetails] = useState(false);

  if (state.status !== "ready") {
    return (
      <DashboardPage>
        <DashboardPageHeader title="Settings" />
        <DashboardStateNotice state={state} />
      </DashboardPage>
    );
  }

  const admin = state.context.currentMemberRole === "owner" || state.context.currentMemberRole === "admin";
  const organization = state.context.organization;
  const detailsDirty =
    name.trim() !== organization.name ||
    avatarSeed !== organization.avatarSeed;

  async function saveDetails() {
    if (!admin || !detailsDirty || savingDetails) return;
    const previous = organization;
    const nextName = name.trim();
    setSavingDetails(true);
    optimisticallyUpdate((context) => ({
      ...context,
      organization: { ...context.organization, name: nextName, avatarSeed },
    }));
    try {
      const response = await fetch("/api/organization-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          section: "details",
          name: nextName,
          avatarSeed,
        }),
      });
      if (!response.ok) throw new Error("organization_details_not_saved");
      await refresh();
      toast.add({ title: "Organization saved", type: "success" });
    } catch {
      optimisticallyUpdate((context) => ({
        ...context,
        organization: {
          ...context.organization,
          name: previous.name,
          avatarSeed: previous.avatarSeed,
        },
      }));
      toast.add({
        title: "Organization was not saved",
        description: "Your previous settings were restored.",
        type: "error",
      });
    } finally {
      setSavingDetails(false);
    }
  }

  function cancelDetails() {
    setName(organization.name);
    setAvatarSeed(organization.avatarSeed);
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
                  <OrganizationIdentityAvatar identity={avatarSeed} name={name || organization.name} className="size-10" />
                  {admin ? (
                    <Button variant="outline" onClick={() => setAvatarSeed(crypto.randomUUID())}>Regenerate</Button>
                  ) : null}
                </div>
              </Field>
              <Field orientation="responsive" className="p-4">
                <FieldContent>
                  <FieldLabel htmlFor="organization-name">Name</FieldLabel>
                  <FieldDescription>Shown to members and Agents.</FieldDescription>
                </FieldContent>
                <Input id="organization-name" name="organization-name" autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} className="w-full @md/field-group:max-w-md" disabled={!admin} />
              </Field>
              <ReadOnlyRow label="Slug" description="Stable organization handle." value={organization.slug} />
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
