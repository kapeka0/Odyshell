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
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { activeUserTheme, nextUserTheme } from "@/lib/theme-cycle";

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
  const nextTheme = nextUserTheme(activeTheme);
  const ThemeIcon =
    activeTheme === "system"
      ? MonitorIcon
      : activeTheme === "dark"
        ? MoonIcon
        : SunIcon;

  return (
    <DashboardPage>
      <DashboardPageHeader
        eyebrow="Account"
        title="User settings"
        description="Manage preferences for your Odyshell account."
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
          <CardDescription>
            Cycle between system, light and dark appearance.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setTheme(nextTheme);
              toast.add({
                title: `Theme set to ${nextTheme}`,
                description:
                  nextTheme === "system"
                    ? "Odyshell now follows your device."
                    : `Odyshell now uses the ${nextTheme} theme.`,
                type: "success",
              });
            }}
          >
            <ThemeIcon aria-hidden="true" />
            {capitalize(activeTheme)}
          </Button>
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

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
