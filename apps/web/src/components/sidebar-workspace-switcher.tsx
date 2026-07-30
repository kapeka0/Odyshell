"use client";

import { OrganizationSwitcher } from "@clerk/nextjs";
import { Brand } from "@/components/brand";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export function SidebarWorkspaceSwitcher() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          className="pointer-events-none group-data-[collapsible=icon]:justify-center"
          render={<div />}
        >
          <Brand compact />
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">Odyshell</span>
            <span className="truncate text-xs text-muted-foreground">Cloud workspace</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
        <OrganizationSwitcher
          afterCreateOrganizationUrl="/dashboard"
          afterSelectOrganizationUrl="/dashboard"
          hidePersonal
          appearance={{
            elements: {
              rootBox: "w-full",
              organizationSwitcherTrigger:
                "w-full justify-between rounded-lg border-0 px-2 py-2 shadow-none hover:bg-sidebar-accent",
              organizationPreview: "min-w-0",
              organizationPreviewTextContainer: "min-w-0",
              organizationPreviewMainIdentifier: "truncate text-sm font-medium",
              organizationPreviewSecondaryIdentifier: "truncate text-xs",
            },
          }}
        />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
