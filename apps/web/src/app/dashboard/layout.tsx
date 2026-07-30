import { AppShell } from "@/components/app-shell";
import { dashboardState } from "@/lib/dashboard-context";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const state = await dashboardState();
  const title =
    state.status === "ready" ? state.context.organization.name : "Workspace";

  return <AppShell title={title}>{children}</AppShell>;
}
