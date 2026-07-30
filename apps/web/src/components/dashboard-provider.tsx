"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useState,
} from "react";
import { DashboardLiveRefresh } from "@/components/dashboard-live-refresh";
import type { DashboardState } from "@/lib/dashboard-context";

type DashboardContextValue = {
  state: DashboardState;
  serverUrl: string;
  refresh: () => Promise<boolean>;
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({
  value,
  children,
}: {
  value: Pick<DashboardContextValue, "state" | "serverUrl">;
  children: React.ReactNode;
}) {
  const [state, setState] = useState(value.state);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/dashboard/context", {
        cache: "no-store",
      });
      if (!response.ok) return false;
      const nextState = (await response.json()) as DashboardState;
      startTransition(() => setState(nextState));
      return true;
    } catch {
      return false;
    }
  }, []);

  return (
    <DashboardContext.Provider
      value={{ state, serverUrl: value.serverUrl, refresh }}
    >
      <DashboardLiveRefresh
        refresh={refresh}
        serverUrl={value.serverUrl}
      />
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
