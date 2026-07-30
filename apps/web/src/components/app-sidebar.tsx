"use client";

import {
  ActivityIcon,
  CpuIcon,
  GaugeIcon,
  KeyRoundIcon,
} from "lucide-react";
import { SidebarNav } from "@/components/sidebar-nav";
import { SidebarUser } from "@/components/sidebar-user";
import { SidebarWorkspaceSwitcher } from "@/components/sidebar-workspace-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";

const workspaceItems = [
  { label: "Overview", href: "/dashboard", icon: GaugeIcon },
  { label: "Machines", href: "/dashboard/machines", icon: CpuIcon },
  { label: "Agent access", href: "/dashboard/access", icon: KeyRoundIcon },
  { label: "Activity", href: "/dashboard/activity", icon: ActivityIcon },
] as const;

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarWorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarNav label="Workspace" items={workspaceItems} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
