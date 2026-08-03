"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useState,
} from "react";
import { DashboardLiveRefresh } from "@/components/dashboard-live-refresh";
import type { CloudContext } from "@/lib/cloud-api";
import type { DashboardState } from "@/lib/dashboard-context";

type DashboardContextValue = {
  state: DashboardState;
  serverUrl: string;
  liveUpdatesDelayed: boolean;
  refresh: () => Promise<boolean>;
  optimisticallyUpdate: (update: (context: CloudContext) => CloudContext) => void;
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
  const [liveUpdatesDelayed, setLiveUpdatesDelayed] = useState(false);

  const optimisticallyUpdate = useCallback(
    (update: (context: CloudContext) => CloudContext) => {
      setState((current) =>
        current.status === "ready"
          ? { ...current, context: update(current.context) }
          : current,
      );
    },
    [],
  );

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
      value={{
        state,
        serverUrl: value.serverUrl,
        liveUpdatesDelayed,
        refresh,
        optimisticallyUpdate,
      }}
    >
      <DashboardLiveRefresh
        refresh={refresh}
        serverUrl={value.serverUrl}
        onDelayedChange={setLiveUpdatesDelayed}
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
