"use client";

import { QuickActions } from "@/components/quick-actions";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

export function AppShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <AppSidebar variant="inset" />
      <SidebarInset id="main-content" tabIndex={-1} className="overflow-hidden">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background/92 px-4 backdrop-blur-md md:px-6">
          <SidebarTrigger aria-label="Toggle workspace navigation" />
          <Separator
            orientation="vertical"
            className="h-4 self-center"
            aria-hidden="true"
          />
          <p className="truncate text-sm font-medium">{title}</p>
          <div className="ml-auto">
            <QuickActions />
          </div>
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
