"use client";

import { UserButton } from "@clerk/nextjs";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export function SidebarUser() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex min-h-12 items-center justify-between gap-2 rounded-lg px-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:px-0">
          <UserButton showName />
          <ThemeToggle />
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
