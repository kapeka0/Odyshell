import { SettingsPageSkeleton } from "@/components/dashboard-skeletons";

export default function UserSettingsLoading() {
  return <SettingsPageSkeleton sections={[3, 1]} actionSections={[0, 1]} />;
}
