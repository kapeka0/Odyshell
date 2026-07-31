import { Skeleton } from "@/components/ui/skeleton";

export default function SessionLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 md:px-8 md:py-12"
      aria-busy="true"
      aria-label="Loading session"
    >
      <Skeleton className="h-9 w-72 max-w-full" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Skeleton className="h-96 rounded-xl" />
        <div className="flex flex-col gap-6">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-44 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
