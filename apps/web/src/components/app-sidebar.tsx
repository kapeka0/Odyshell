"use client";

import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  Code2Icon,
  CpuIcon,
  GaugeIcon,
  KeyRoundIcon,
  TerminalIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

const workspaceItems = [
  { label: "Overview", href: "/dashboard#overview", hash: "#overview", icon: GaugeIcon },
  { label: "Machines", href: "/dashboard#machines", hash: "#machines", icon: CpuIcon },
  { label: "Agent access", href: "/dashboard#agent-access", hash: "#agent-access", icon: KeyRoundIcon },
  { label: "Control events", href: "/dashboard#control-events", hash: "#control-events", icon: ActivityIcon },
] as const;

const secondaryItems = [
  { label: "Activate CLI", href: "/activate", icon: TerminalIcon, external: false },
  { label: "GitHub", href: "https://github.com/kapeka0/odyshell", icon: Code2Icon, external: true },
] as const;

export function AppSidebar() {
  const pathname = usePathname();
  const [hash, setHash] = useState("#overview");
  const { setOpenMobile } = useSidebar();

  useEffect(() => {
    const syncHash = () => setHash(window.location.hash || "#overview");
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  const closeMobile = () => setOpenMobile(false);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border p-2">
        <div className="flex h-9 items-center gap-2 px-2">
          <Brand compact />
          <span className="truncate font-heading text-sm font-semibold group-data-[collapsible=icon]:hidden">
            Odyshell
          </span>
        </div>
        <div className="group-data-[collapsible=icon]:hidden">
          <OrganizationSwitcher
            afterCreateOrganizationUrl="/dashboard"
            afterSelectOrganizationUrl="/dashboard"
            hidePersonal
            appearance={{
              elements: {
                rootBox: "w-full",
                organizationSwitcherTrigger:
                  "w-full justify-between rounded-md border-0 px-2 py-2 shadow-none hover:bg-sidebar-accent",
                organizationPreview: "min-w-0",
                organizationPreviewTextContainer: "min-w-0",
                organizationPreviewMainIdentifier: "truncate text-sm font-medium",
                organizationPreviewSecondaryIdentifier: "truncate text-xs",
              },
            }}
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {workspaceItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link href={item.href} onClick={closeMobile} />}
                    isActive={pathname === "/dashboard" && hash === item.hash}
                    tooltip={item.label}
                  >
                    <item.icon aria-hidden="true" />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupLabel>Resources</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {secondaryItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={
                      item.external ? (
                        <a href={item.href} target="_blank" rel="noreferrer" />
                      ) : (
                        <Link href={item.href} onClick={closeMobile} />
                      )
                    }
                    isActive={!item.external && pathname === item.href}
                    tooltip={item.label}
                  >
                    <item.icon aria-hidden="true" />
                    <span>{item.label}</span>
                    {item.external ? (
                      <ArrowUpRightIcon
                        aria-hidden="true"
                        className="ml-auto group-data-[collapsible=icon]:hidden"
                      />
                    ) : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="flex items-center justify-between gap-2 px-1 group-data-[collapsible=icon]:flex-col">
          <UserButton showName />
          <ThemeToggle />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
