"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import {
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";
import {
  DashboardPage,
  DashboardPageHeader,
} from "@/components/dashboard-state";
import { UserIdentityAvatar } from "@/components/identity-avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { activeUserTheme } from "@/lib/theme-cycle";

export default function UserSettingsPage() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const { theme, setTheme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);

  if (!isLoaded || !user) {
    return (
      <DashboardPage>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-52 w-full" />
      </DashboardPage>
    );
  }

  const name =
    user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "Account";
  const email = user.primaryEmailAddress?.emailAddress ?? "No email";
  const activeTheme = activeUserTheme(theme);

  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Account"
        title="Settings"
      />
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Identity details come from your sign-in provider.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <UserIdentityAvatar
            identity={user.id}
            imageUrl={user.hasImage ? user.imageUrl : undefined}
            name={name}
            className="size-14"
          />
          <div className="min-w-0">
            <p className="truncate font-medium">{name}</p>
            <p className="truncate text-sm text-muted-foreground">{email}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Choose a theme.</CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={activeTheme}
            onValueChange={(value) => setTheme(value ?? "system")}
          >
            <SelectTrigger aria-label="Theme" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectGroup>
                <SelectItem value="system">
                  <MonitorIcon aria-hidden="true" />
                  System
                </SelectItem>
                <SelectItem value="light">
                  <SunIcon aria-hidden="true" />
                  Light
                </SelectItem>
                <SelectItem value="dark">
                  <MoonIcon aria-hidden="true" />
                  Dark
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>End this browser session.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true);
              void signOut({ redirectUrl: "/" });
            }}
          >
            {signingOut ? <Spinner /> : <LogOutIcon aria-hidden="true" />}
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </CardContent>
      </Card>
    </DashboardPage>
  );
}
