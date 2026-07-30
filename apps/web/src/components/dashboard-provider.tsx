"use client";

import { createContext, useContext } from "react";
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
