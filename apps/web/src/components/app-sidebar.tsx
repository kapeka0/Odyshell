"use client";

import {
  ActivityIcon,
  Code2Icon,
  CpuIcon,
  GaugeIcon,
  KeyRoundIcon,
  TerminalIcon,
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

const secondaryItems = [
  { label: "Activate CLI", href: "/activate", icon: TerminalIcon },
  { label: "GitHub", href: "https://github.com/kapeka0/odyshell", icon: Code2Icon, external: true },
] as const;

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarWorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarNav label="Workspace" items={workspaceItems} />
        <SidebarNav label="Resources" items={secondaryItems} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <SidebarUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
