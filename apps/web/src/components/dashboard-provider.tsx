"use client";

import { createContext, useContext } from "react";
import { DashboardLiveRefresh } from "@/components/dashboard-live-refresh";
import type { DashboardState } from "@/lib/dashboard-context";

type DashboardContextValue = {
  state: DashboardState;
  serverUrl: string;
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({
  value,
  children,
}: {
  value: DashboardContextValue;
  children: React.ReactNode;
}) {
  return (
    <DashboardContext.Provider value={value}>
      <DashboardLiveRefresh />
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard(): DashboardContextValue {
  const value = useContext(DashboardContext);
  if (!value) {
    throw new Error("useDashboard must be used within DashboardProvider");
  }
  return value;
}
