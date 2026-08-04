"use client";

import { useUser } from "@clerk/nextjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "@/components/dashboard-provider";
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardStateNotice,
} from "@/components/dashboard-state";
import { UserIdentityAvatar } from "@/components/identity-avatar";
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

const SYSTEM_TIME_ZONE = "System";

export default function UserSettingsPage() {
  const { state, optimisticallyUpdate, refresh } = useDashboard();
  const { user, isLoaded } = useUser();
  const fileRef = useRef<HTMLInputElement>(null);
  const [firstName, setFirstName] = useState<string | null>(null);
  const [lastName, setLastName] = useState<string | null>(null);
  const [timeZone, setTimeZone] = useState(
    state.status === "ready" ? state.context.userPreferences.timeZone : SYSTEM_TIME_ZONE,
  );
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingTimeZone, setSavingTimeZone] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const timeZones = useMemo(() => {
    const supported = (
      Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }
    ).supportedValuesOf?.("timeZone") ?? [];
    return [SYSTEM_TIME_ZONE, ...supported];
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (state.status !== "ready") {
    return (
      <DashboardPage>
        <DashboardPageHeader title="Settings" />
        <DashboardStateNotice state={state} />
      </DashboardPage>
    );
  }

  const context = state.context;

  const imageUrl = previewUrl
    ? previewUrl
    : removeImage
      ? undefined
      : user?.imageUrl;
  const effectiveFirstName = firstName ?? user?.firstName ?? "";
  const effectiveLastName = lastName ?? user?.lastName ?? "";
  const name = [effectiveFirstName, effectiveLastName].filter(Boolean).join(" ") || "User";
  const profileDirty =
    effectiveFirstName !== (user?.firstName ?? "") ||
    effectiveLastName !== (user?.lastName ?? "") ||
    imageFile !== null ||
    removeImage;
  const timeZoneDirty = timeZone !== context.userPreferences.timeZone;

  async function saveProfile() {
    if (!user || !profileDirty || savingProfile) return;
    setSavingProfile(true);
    try {
      await user.update({
        firstName: effectiveFirstName.trim() || null,
        lastName: effectiveLastName.trim() || null,
      });
      if (imageFile) await user.setProfileImage({ file: imageFile });
      if (removeImage) await user.setProfileImage({ file: null });
      setImageFile(null);
      setPreviewUrl(null);
      setFirstName(null);
      setLastName(null);
      setRemoveImage(false);
      await user.reload();
      toast.add({ title: "Profile saved", type: "success" });
    } catch {
      toast.add({
        title: "Profile was not saved",
        description: "Review the fields and try again.",
        type: "error",
      });
    } finally {
      setSavingProfile(false);
    }
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
      toast.add({
        title: "Timezone was not saved",
        description: "Try again.",
        type: "error",
      });
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
          <p className="text-sm text-muted-foreground">Personal details and photo.</p>
        </div>
        <Card>
          <CardContent className="p-0">
            <FieldGroup className="gap-0">
              <Field orientation="responsive" className="border-b p-4">
                <FieldContent>
                  <FieldTitle>Photo</FieldTitle>
                  <FieldDescription>Your profile image.</FieldDescription>
                </FieldContent>
                <div className="flex w-full items-center justify-end gap-2 @md/field-group:w-auto">
                  <UserIdentityAvatar
                    identity={user?.id ?? "user"}
                    imageUrl={imageUrl}
                    name={name}
                    className="size-10"
                  />
                  <Input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      if (file.size > 5 * 1024 * 1024) {
                        toast.add({ title: "Image is too large", description: "Use an image under 5 MB.", type: "error" });
                        return;
                      }
                      if (previewUrl) URL.revokeObjectURL(previewUrl);
                      setPreviewUrl(URL.createObjectURL(file));
                      setImageFile(file);
                      setRemoveImage(false);
                    }}
                  />
                  <Button variant="outline" onClick={() => fileRef.current?.click()}>Upload</Button>
                  {(user?.hasImage || imageFile) ? (
                    <Button variant="ghost" onClick={() => {
                      if (previewUrl) URL.revokeObjectURL(previewUrl);
                      setPreviewUrl(null);
                      setImageFile(null);
                      setRemoveImage(true);
                    }}>Remove</Button>
                  ) : null}
                </div>
              </Field>
              <Field orientation="responsive" className="border-b p-4">
                <FieldContent>
                  <FieldLabel htmlFor="first-name">First name</FieldLabel>
                </FieldContent>
                <Input id="first-name" value={effectiveFirstName} onChange={(event) => setFirstName(event.target.value)} className="w-full @md/field-group:max-w-md" disabled={!isLoaded} />
              </Field>
              <Field orientation="responsive" className="p-4">
                <FieldContent>
                  <FieldLabel htmlFor="last-name">Last name</FieldLabel>
                </FieldContent>
                <Input id="last-name" value={effectiveLastName} onChange={(event) => setLastName(event.target.value)} className="w-full @md/field-group:max-w-md" disabled={!isLoaded} />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button variant="outline" disabled={!profileDirty || savingProfile} onClick={() => {
              setFirstName(null);
              setLastName(null);
              setImageFile(null);
              setPreviewUrl(null);
              setRemoveImage(false);
            }}>Cancel</Button>
            <Button disabled={!profileDirty || savingProfile} onClick={() => void saveProfile()}>
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
          <CardHeader className="sr-only">
            <CardTitle>Localization</CardTitle>
            <CardDescription>Dates and times.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Field orientation="responsive" className="p-4">
              <FieldContent>
                <FieldTitle>Timezone</FieldTitle>
                <FieldDescription>System follows this browser.</FieldDescription>
              </FieldContent>
              <Select items={timeZones.map((value) => ({ label: value, value }))} value={timeZone} onValueChange={(value) => value && setTimeZone(value)}>
                <SelectTrigger className="w-full @md/field-group:w-72"><SelectValue /></SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>{timeZones.map((zone) => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}</SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button variant="outline" disabled={!timeZoneDirty || savingTimeZone} onClick={() => {
              setTimeZone(context.userPreferences.timeZone);
            }}>Cancel</Button>
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
