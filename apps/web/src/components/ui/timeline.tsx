import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Adapted to Odyshell's Base UI stack from timDeHof/shadcn-timeline (MIT).
export function Timeline({ className, ...props }: ComponentProps<"ol">) {
  return <ol className={cn("relative flex flex-col", className)} {...props} />;
}

export function TimelineItem({ className, ...props }: ComponentProps<"li">) {
  return (
    <li
      className={cn(
        "group relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 pb-6 last:pb-0",
        className,
      )}
      {...props}
    />
  );
}

export function TimelineMarker({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "relative z-10 mt-1 flex size-7 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-xs [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export function TimelineConnector({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute top-7 bottom-0 left-[0.84375rem] w-px bg-border group-last:hidden",
        className,
      )}
      {...props}
    />
  );
}

export function TimelineContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0 pt-0.5", className)} {...props} />;
}
