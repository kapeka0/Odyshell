import { Skeleton } from "@/components/ui/skeleton";

export default function DocsLoading() {
  return (
    <main
      className="page-shell grid gap-10 py-16 md:py-24 lg:grid-cols-[0.65fr_1.35fr]"
      aria-busy="true"
      aria-label="Loading documentation"
    >
      <div className="space-y-5">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-14 w-72 max-w-full" />
        <Skeleton className="h-20 w-full max-w-md" />
      </div>
      <div className="space-y-8 border-t pt-8">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="space-y-3 border-b pb-8">
            <Skeleton className="h-6 w-36" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ))}
      </div>
    </main>
  );
}
