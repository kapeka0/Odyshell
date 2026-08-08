"use client";

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
import { authClient } from "@/lib/auth-client";

const themeOptions = {
  system: { icon: MonitorIcon, label: "System" },
  light: { icon: SunIcon, label: "Light" },
  dark: { icon: MoonIcon, label: "Dark" },
} satisfies Record<UserTheme, { icon: typeof MonitorIcon; label: string }>;

export function SidebarUser() {
  const { isMobile } = useSidebar();
  const session = authClient.useSession();
  const { theme, setTheme } = useTheme();
  const [pending, setPending] = useState(false);

  if (session.isPending || !session.data?.user) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const user = session.data.user;
  const name = user.name || user.email || "Account";
  const email = user.email;
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
              imageUrl={user.image ?? undefined}
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
            className="min-w-56 p-2"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="px-2 py-2">
                <span className="block truncate text-foreground">{name}</span>
                <span className="block truncate font-normal">{email}</span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup className="flex flex-col gap-1">
              <DropdownMenuItem
                className="px-2 py-2"
                onClick={() => setTheme(nextUserTheme(activeTheme))}
              >
                <ThemeIcon aria-hidden="true" />
                {themeOption.label}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="px-2 py-2"
                render={<Link href="/dashboard/user-settings" />}
              >
                <SettingsIcon aria-hidden="true" />
                Settings
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup className="flex flex-col gap-1">
              <DropdownMenuItem
                className="px-2 py-2"
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  void authClient.signOut({
                    fetchOptions: { onSuccess: () => window.location.assign("/") },
                  });
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
