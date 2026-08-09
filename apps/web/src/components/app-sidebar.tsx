"use client";

import {
  ActivityIcon,
  BotIcon,
  CpuIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  ListTodoIcon,
} from "lucide-react";
import { SidebarNav } from "@/components/sidebar-nav";
import { SidebarUser } from "@/components/sidebar-user";
import { SidebarOrganizationSwitcher } from "@/components/sidebar-organization-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";

const organizationItems = [
  { label: "Overview", href: "/dashboard", icon: LayoutDashboardIcon },
  { label: "Machines", href: "/dashboard/machines", icon: CpuIcon },
  { label: "Agents", href: "/dashboard/agents", icon: BotIcon },
  { label: "Sessions", href: "/dashboard/sessions", icon: ListTodoIcon },
  { label: "Activity", href: "/dashboard/activity", icon: ActivityIcon },
] as const;

const organizationSettingsItems = [
  { label: "Settings", href: "/dashboard/settings", icon: SettingsIcon },
] as const;

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarOrganizationSwitcher />
      </SidebarHeader>
      <SidebarContent className="overflow-hidden">
        <SidebarNav label="Organization" items={organizationItems} />
        <SidebarNav label="Manage" items={organizationSettingsItems} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarUser />
      </SidebarFooter>
    </Sidebar>
  );
}
