"use client";

import {
  ActivityIcon,
  BotIcon,
  CpuIcon,
  GaugeIcon,
  SettingsIcon,
} from "lucide-react";
import { SidebarNav } from "@/components/sidebar-nav";
import { SidebarUser } from "@/components/sidebar-user";
import { SidebarWorkspaceSwitcher } from "@/components/sidebar-workspace-switcher";
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
  { label: "Activity", href: "/dashboard/activity", icon: ActivityIcon },
] as const;

const workspaceSettingsItems = [
  { label: "Settings", href: "/dashboard/settings", icon: SettingsIcon },
] as const;

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarWorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent className="overflow-hidden">
        <SidebarNav label="Workspace" items={workspaceItems} />
        <SidebarNav
          label="Manage"
          items={workspaceSettingsItems}
          className="mt-auto"
        />
      </SidebarContent>
      <SidebarFooter>
        <SidebarUser />
      </SidebarFooter>
    </Sidebar>
  );
}
