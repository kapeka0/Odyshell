"use client";

import { useMemo, useState } from "react";
import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";

const SYSTEM_TIME_ZONE = "System";

export default function UserSettingsPage() {
  const { state, optimisticallyUpdate, refresh } = useDashboard();
  const session = authClient.useSession();
  const [name, setName] = useState<string | null>(null);
  const [timeZone, setTimeZone] = useState(
    state.status === "ready" ? state.context.userPreferences.timeZone : SYSTEM_TIME_ZONE,
  );
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingTimeZone, setSavingTimeZone] = useState(false);
  const timeZones = useMemo(() => {
    const supported = (
      Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }
    ).supportedValuesOf?.("timeZone") ?? [];
    return [SYSTEM_TIME_ZONE, ...supported];
  }, []);

  if (state.status !== "ready") {
    return (
      <DashboardPage>
        <DashboardPageHeader title="Settings" />
        <DashboardStateNotice state={state} />
      </DashboardPage>
    );
  }

  const context = state.context;
  const currentName = session.data?.user.name ?? "";
  const effectiveName = name ?? currentName;
  const profileDirty = effectiveName.trim() !== currentName;
  const timeZoneDirty = timeZone !== context.userPreferences.timeZone;

  async function saveProfile() {
    if (!profileDirty || savingProfile || !effectiveName.trim()) return;
    setSavingProfile(true);
    const result = await authClient.updateUser({ name: effectiveName.trim() });
    if (result.error) {
      toast.add({
        title: "Profile was not saved",
        description: result.error.message ?? "Review the field and try again.",
        type: "error",
      });
    } else {
      setName(null);
      await session.refetch();
      toast.add({ title: "Profile saved", type: "success" });
    }
    setSavingProfile(false);
  }

  async function saveTimeZone() {
    if (!timeZoneDirty || savingTimeZone) return;
    const previousTimeZone = context.userPreferences.timeZone;
    setSavingTimeZone(true);
    optimisticallyUpdate((context) => ({
      ...context,
      userPreferences: { timeZone },
    }));
    try {
      const response = await fetch("/api/user-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeZone }),
      });
      if (!response.ok) throw new Error("preferences_not_saved");
      await refresh();
      toast.add({ title: "Timezone saved", type: "success" });
    } catch {
      optimisticallyUpdate((context) => ({
        ...context,
        userPreferences: { timeZone: previousTimeZone },
      }));
      setTimeZone(previousTimeZone);
      toast.add({ title: "Timezone was not saved", description: "Try again.", type: "error" });
    } finally {
      setSavingTimeZone(false);
    }
  }

  return (
    <DashboardPage>
      <DashboardPageHeader title="Settings" />

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-heading text-lg font-medium">Profile</h2>
          <p className="text-sm text-muted-foreground">Your human supervisor identity.</p>
        </div>
        <Card>
          <CardContent className="p-0">
            <FieldGroup className="gap-0">
              <Field orientation="responsive" className="p-4">
                <FieldContent>
                  <FieldLabel htmlFor="display-name">Display name</FieldLabel>
                  <FieldDescription>Shown to other organization members in audit activity.</FieldDescription>
                </FieldContent>
                <Input
                  id="display-name"
                  name="name"
                  autoComplete="name"
                  value={effectiveName}
                  onChange={(event) => setName(event.target.value)}
                  className="w-full @md/field-group:max-w-md"
                  disabled={session.isPending}
                />
              </Field>
              <Field orientation="responsive" className="p-4">
                <FieldContent>
                  <FieldTitle>Email</FieldTitle>
                  <FieldDescription>Your sign-in identifier.</FieldDescription>
                </FieldContent>
                <p className="text-sm text-muted-foreground">{session.data?.user.email}</p>
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter className="justify-end gap-2 border-0 bg-card">
            <Button variant="outline" disabled={!profileDirty || savingProfile} onClick={() => setName(null)}>Cancel</Button>
            <Button disabled={!profileDirty || savingProfile || !effectiveName.trim()} onClick={() => void saveProfile()}>
              {savingProfile ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </CardFooter>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-heading text-lg font-medium">Localization</h2>
          <p className="text-sm text-muted-foreground">Dates and times.</p>
        </div>
        <Card>
          <CardContent className="p-0">
            <Field orientation="responsive" className="p-4">
              <FieldContent>
                <FieldTitle>Timezone</FieldTitle>
                <FieldDescription>Controls how dates and times appear across the dashboard.</FieldDescription>
              </FieldContent>
              <Select items={timeZones.map((value) => ({ label: value, value }))} value={timeZone} onValueChange={(value) => value && setTimeZone(value)}>
                <SelectTrigger className="w-full @md/field-group:w-72"><SelectValue /></SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>{timeZones.map((zone) => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}</SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </CardContent>
          <CardFooter className="justify-end gap-2 border-0 bg-card">
            <Button variant="outline" disabled={!timeZoneDirty || savingTimeZone} onClick={() => setTimeZone(context.userPreferences.timeZone)}>Cancel</Button>
            <Button disabled={!timeZoneDirty || savingTimeZone} onClick={() => void saveTimeZone()}>
              {savingTimeZone ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </CardFooter>
        </Card>
      </section>
    </DashboardPage>
  );
}
