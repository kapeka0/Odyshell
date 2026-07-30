import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div
      className="flex min-h-[calc(100svh-3.5rem)] flex-1 p-4 md:p-6"
      aria-busy="true"
      aria-label="Loading workspace"
    >
      <Skeleton className="min-h-[32rem] w-full flex-1 rounded-xl" />
    </div>
  );
}
