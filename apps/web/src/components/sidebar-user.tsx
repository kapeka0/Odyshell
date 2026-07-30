"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import {
  ChevronsUpDownIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useState } from "react";
import { UserIdentityAvatar } from "@/components/identity-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import {
  activeUserTheme,
  nextUserTheme,
  type UserTheme,
} from "@/lib/theme-cycle";

const themeOptions = {
  system: { icon: MonitorIcon, label: "System" },
  light: { icon: SunIcon, label: "Light" },
  dark: { icon: MoonIcon, label: "Dark" },
} satisfies Record<UserTheme, { icon: typeof MonitorIcon; label: string }>;

export function SidebarUser() {
  const { isMobile } = useSidebar();
  const { isLoaded, user } = useUser();
  const { signOut } = useClerk();
  const { theme, setTheme } = useTheme();
  const [pending, setPending] = useState(false);

  if (!isLoaded || !user) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const name = user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "Account";
  const email = user.primaryEmailAddress?.emailAddress ?? "";
  const activeTheme = activeUserTheme(theme);
  const themeOption = themeOptions[activeTheme];
  const ThemeIcon = themeOption.icon;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-open:bg-sidebar-accent"
                tooltip={name}
              />
            }
          >
            <UserIdentityAvatar
              identity={user.id}
              imageUrl={user.hasImage ? user.imageUrl : undefined}
              name={name}
            />
            <div className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {email}
              </span>
            </div>
            <ChevronsUpDownIcon
              aria-hidden="true"
              className="ml-auto group-data-[collapsible=icon]:hidden"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={isMobile ? "bottom" : "right"}
            align="end"
            className="min-w-56"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                <span className="block truncate text-foreground">{name}</span>
                <span className="block truncate font-normal">{email}</span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => setTheme(nextUserTheme(activeTheme))}
              >
                <ThemeIcon aria-hidden="true" />
                {themeOption.label}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={<Link href="/dashboard/user-settings" />}
              >
                <SettingsIcon aria-hidden="true" />
                Settings
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  void signOut({ redirectUrl: "/" });
                }}
              >
                {pending ? <Spinner /> : <LogOutIcon aria-hidden="true" />}
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
