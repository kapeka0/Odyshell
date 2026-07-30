"use client";

import { QuickActions } from "@/components/quick-actions";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

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
      <AppSidebar />
      <SidebarInset id="main-content" tabIndex={-1}>
        <header className="sticky top-0 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur-md md:px-6">
          <SidebarTrigger aria-label="Toggle workspace navigation" />
          <div className="h-4 w-px bg-border" aria-hidden="true" />
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

