import { SettingsPageSkeleton } from "@/components/dashboard-skeletons";

export default function WorkspaceSettingsLoading() {
  return <SettingsPageSkeleton sections={[6, 1, 3]} actionSections={[0, 1]} />;
}
