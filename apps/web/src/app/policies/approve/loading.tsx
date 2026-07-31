import { ActivationShell } from "@/components/activation-shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function AgentPolicyApprovalLoading() {
  return (
    <ActivationShell title="Approve policy" description="Loading policy…">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-20 w-full" />
        <div className="flex justify-end gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
    </ActivationShell>
  );
}
