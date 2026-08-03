import { Skeleton } from "@/components/ui/skeleton";

export function OverviewSkeleton() {
  return (
    <div
      className="flex min-h-[calc(100svh-3.5rem)] flex-1 p-4 md:p-6"
      aria-busy="true"
      aria-label="Loading overview"
    >
      <Skeleton className="min-h-[32rem] w-full flex-1 rounded-xl" />
    </div>
  );
}

export function TablePageSkeleton({
  toolbarAction = false,
  filters = 1,
  columns = 4,
  summary = false,
}: {
  toolbarAction?: boolean;
  filters?: number;
  columns?: number;
  summary?: boolean;
}) {
  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 md:px-8 md:py-12"
      aria-busy="true"
      aria-label="Loading table"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-1 gap-2">
            <Skeleton className="h-10 w-full max-w-xs" />
            {Array.from({ length: filters }, (_, index) => (
              <Skeleton key={index} className="hidden h-10 w-40 sm:block" />
            ))}
          </div>
          {toolbarAction ? <Skeleton className="h-10 w-20" /> : null}
        </div>
        <div
          className="flex items-center justify-between gap-4"
          aria-label="Loading results"
        >
          <Skeleton className="h-5 w-16" />
          {summary ? <Skeleton className="h-5 w-28" /> : null}
        </div>
        <div className="overflow-hidden rounded-lg border">
          <div
            className="grid gap-6 border-b px-4 py-3"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: columns }, (_, index) => (
              <Skeleton key={index} className="h-4 w-20 max-w-full" />
            ))}
          </div>
          {Array.from({ length: 5 }, (_, row) => (
            <div
              key={row}
              className="grid gap-6 border-b px-4 py-4 last:border-b-0"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {Array.from({ length: columns }, (_, column) => (
                <Skeleton
                  key={column}
                  className={column === 0 ? "h-5 w-28" : "h-5 w-20"}
                />
              ))}
            </div>
          ))}
        </div>
        <div
          className="flex justify-center"
          aria-label="Loading pagination"
        >
          <Skeleton className="h-8 w-28" />
        </div>
      </div>
    </div>
  );
}

export function SettingsPageSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 md:px-8 md:py-12"
      aria-busy="true"
      aria-label="Loading settings"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-9 w-32" />
      </div>
      {Array.from({ length: cards }, (_, index) => (
        <div key={index} className="flex flex-col gap-5 rounded-xl border p-6">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-40" />
          </div>
          <Skeleton className={index === 0 ? "h-14 w-full" : "h-16 w-full"} />
        </div>
      ))}
    </div>
  );
}

export function EmptySettingsPageSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 md:px-8 md:py-12"
      aria-busy="true"
      aria-label="Loading settings"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-xl border">
        <Skeleton className="size-8 rounded-lg" />
        <Skeleton className="h-5 w-40" />
      </div>
    </div>
  );
}

export function FormPageSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 md:px-8 md:py-12"
      aria-busy="true"
      aria-label="Loading form"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="flex flex-col gap-6 rounded-xl border p-6">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-8 w-32" />
      </div>
    </div>
  );
}
