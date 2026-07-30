import { Skeleton } from "@/components/ui/skeleton";

export default function DocsLoading() {
  return (
    <article
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 md:px-8 md:py-14"
      aria-busy="true"
      aria-label="Loading documentation"
    >
      <div className="flex flex-col gap-4 border-b pb-6">
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="h-5 w-full max-w-xl" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="flex flex-col gap-8">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col gap-3">
            <Skeleton className="h-7 w-48 max-w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            {index === 1 ? <Skeleton className="h-28 w-full" /> : null}
          </div>
        ))}
      </div>
    </article>
  );
}
