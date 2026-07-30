import { AppShell } from "@/components/app-shell";
import { DashboardProvider } from "@/components/dashboard-provider";
import { publicServerUrl } from "@/lib/cloud-api";
import { dashboardState } from "@/lib/dashboard-context";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const state = await dashboardState();
  const title =
    state.status === "ready" ? state.context.organization.name : "Workspace";
  const providerKey =
    state.status === "ready" ? state.context.workspace.id : state.status;

  return (
    <DashboardProvider
      key={providerKey}
      value={{
        state,
        serverUrl: publicServerUrl(),
      }}
    >
      <AppShell title={title}>{children}</AppShell>
    </DashboardProvider>
  );
}
