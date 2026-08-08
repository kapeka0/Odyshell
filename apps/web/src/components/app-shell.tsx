"use client";

import { WifiOffIcon } from "lucide-react";
import { QuickActions } from "@/components/quick-actions";
import { NotificationsSheet } from "@/components/notifications-sheet";
import { AppSidebar } from "@/components/app-sidebar";
import { useDashboard } from "@/components/dashboard-provider";
import { Alert, AlertTitle } from "@/components/ui/alert";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export function AppShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const { liveUpdatesDelayed } = useDashboard();

  return (
    <SidebarProvider
      className="flex-col"
      style={
        {
          "--platform-status-height": liveUpdatesDelayed ? "2rem" : "0rem",
        } as React.CSSProperties
      }
    >
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {liveUpdatesDelayed ? (
        <Alert className="h-8 shrink-0 items-center rounded-none border-x-0 border-t-0 px-4 py-0 text-xs [&>svg]:translate-y-0">
          <WifiOffIcon aria-hidden="true" />
          <AlertTitle className="text-xs">Live updates delayed</AlertTitle>
        </Alert>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <AppSidebar variant="inset" className="border-r border-border" />
        <SidebarInset
          id="main-content"
          tabIndex={-1}
          className="min-h-0 overflow-hidden"
        >
          <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background/92 px-4 backdrop-blur-md md:px-6">
            <SidebarTrigger aria-label="Toggle organization navigation" />
            <div className="ml-auto flex items-center gap-1">
              <QuickActions />
              <NotificationsSheet />
            </div>
          </header>
          {children}
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
