import { ActivationShell } from "@/components/activation-shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function SessionApproveLoading() {
  return (
    <ActivationShell
      title="Approve agent access"
      description="Review the exact temporary access requested."
    >
      <div className="space-y-5">
        <div className="space-y-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div
              className="grid grid-cols-[6rem_1fr] items-center gap-3"
              key={index}
            >
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-7 w-full max-w-56" />
            </div>
          ))}
        </div>
        <Skeleton className="h-px w-full" />
        <Skeleton className="h-4 w-4/5" />
        <div className="flex justify-end gap-2">
          <Skeleton className="h-10 w-20 rounded-lg" />
          <Skeleton className="h-10 w-24 rounded-lg" />
        </div>
      </div>
    </ActivationShell>
  );
}
