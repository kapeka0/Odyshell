import { UserRoundCogIcon } from "lucide-react";
import {
  DashboardPage,
  DashboardPageHeader,
} from "@/components/dashboard-state";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export default function UserSettingsPage() {
  return (
    <DashboardPage>
      <DashboardPageHeader eyebrow="Account" title="Settings" />
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UserRoundCogIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No account settings yet</EmptyTitle>
        </EmptyHeader>
      </Empty>
    </DashboardPage>
  );
}
