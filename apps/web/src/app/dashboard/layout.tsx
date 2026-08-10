import { AppShell } from "@/components/app-shell";
import { DashboardProvider } from "@/components/dashboard-provider";
import { publicServerUrl } from "@/lib/control-api";
import { dashboardState } from "@/lib/dashboard-context";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const state = await dashboardState();
  const providerKey =
    state.status === "ready" ? state.context.organization.id : state.status;

  return (
    <DashboardProvider
      key={providerKey}
      value={{
        state,
        serverUrl: publicServerUrl(),
      }}
    >
      <AppShell>{children}</AppShell>
    </DashboardProvider>
  );
}
