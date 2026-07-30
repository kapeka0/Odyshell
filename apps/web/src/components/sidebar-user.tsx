"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import {
  ChevronsUpDownIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
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
import { toast } from "@/components/ui/toast";
import { vercelAvatarUrl } from "@/lib/avatar";
import { activeUserTheme, nextUserTheme } from "@/lib/theme-cycle";

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
  const initials = initialsFor(name);
  const activeTheme = activeUserTheme(theme);
  const nextTheme = nextUserTheme(activeTheme);
  const ThemeIcon =
    activeTheme === "system"
      ? MonitorIcon
      : activeTheme === "dark"
        ? MoonIcon
        : SunIcon;

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
            <Avatar>
              <AvatarImage
                src={vercelAvatarUrl(user.id, initials)}
                alt=""
                referrerPolicy="no-referrer"
              />
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {email}
              </span>
            </div>
            <ChevronsUpDownIcon aria-hidden="true" className="ml-auto" />
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
                Theme: {capitalize(activeTheme)}
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

function initialsFor(name: string): string {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
