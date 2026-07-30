import { DashboardHeader } from "@/components/dashboard-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <>
      <DashboardHeader />
      <main className="page-shell space-y-10 py-10 md:py-14" aria-busy="true">
        <div className="space-y-3">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-11 w-64 max-w-full" />
          <Skeleton className="h-5 w-96 max-w-full" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <div className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </main>
    </>
  );
}
