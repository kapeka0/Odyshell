import { cn } from "@/lib/utils";

export function StatusDot({
  active,
  className,
}: {
  active: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("relative flex size-2 shrink-0", className)}
    >
      {active ? (
        <span className="absolute inset-0 rounded-full bg-emerald-500/60 motion-safe:animate-ping" />
      ) : null}
      <span
        className={cn(
          "relative size-full rounded-full",
          active ? "bg-emerald-500" : "bg-muted-foreground/45",
        )}
      />
    </span>
  );
}
