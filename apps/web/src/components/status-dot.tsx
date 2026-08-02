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
        <span className="absolute inset-0 rounded-full bg-status-success/60 motion-safe:animate-ping" />
      ) : null}
      <span
        className={cn(
          "relative size-full rounded-full",
          active ? "bg-status-success" : "bg-muted-foreground/45",
        )}
      />
    </span>
  );
}
