"use client";

import {
  ActivityIcon,
  BotIcon,
  CpuIcon,
  GaugeIcon,
  SettingsIcon,
  ShieldCheckIcon,
  TimerIcon,
} from "lucide-react";
import { SidebarNav } from "@/components/sidebar-nav";
import { SidebarUser } from "@/components/sidebar-user";
import { SidebarOrganizationSwitcher } from "@/components/sidebar-workspace-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";

const workspaceItems = [
  { label: "Overview", href: "/dashboard", icon: GaugeIcon },
  { label: "Machines", href: "/dashboard/machines", icon: CpuIcon },
  { label: "Agents", href: "/dashboard/agents", icon: BotIcon },
  { label: "Sessions", href: "/dashboard/sessions", icon: TimerIcon },
  { label: "Policies", href: "/dashboard/policies", icon: ShieldCheckIcon },
  { label: "Activity", href: "/dashboard/activity", icon: ActivityIcon },
] as const;

const workspaceSettingsItems = [
  { label: "Settings", href: "/dashboard/settings", icon: SettingsIcon },
] as const;

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarOrganizationSwitcher />
      </SidebarHeader>
      <SidebarContent className="overflow-hidden">
        <SidebarNav label="Organization" items={workspaceItems} />
        <SidebarNav label="Manage" items={workspaceSettingsItems} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarUser />
      </SidebarFooter>
    </Sidebar>
  );
}
