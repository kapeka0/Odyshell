import { ArrowRightIcon, BotIcon, CpuIcon, ServerIcon } from "lucide-react";

const nodes = [
  { label: "Agent", detail: "OAuth identity", icon: BotIcon },
  { label: "Odyshell", detail: "authorize + audit", icon: ServerIcon },
  { label: "Linux Machine", detail: "Local Policy", icon: CpuIcon },
] as const;

export function ConnectionRoute() {
  return (
    <div className="mt-12 grid gap-3 border-t pt-8 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center">
      {nodes.map((node, index) => (
        <div key={node.label} className="contents">
          <div className="rounded-lg border bg-background p-4">
            <node.icon aria-hidden="true" className="text-muted-foreground" />
            <p className="mt-8 font-medium">{node.label}</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {node.detail}
            </p>
          </div>
          {index < nodes.length - 1 ? (
            <div className="hidden items-center sm:flex" aria-hidden="true">
              <span className="agent-route-line h-px w-12 bg-border" />
              <ArrowRightIcon className="-ml-1 size-3 text-muted-foreground" />
            </div>
          ) : null}
        </div>
      ))}
      <p className="mt-3 font-mono text-xs text-muted-foreground sm:col-span-5">
        The Machine opens and maintains the connection. Commands travel only through that
        authenticated route.
      </p>
    </div>
  );
}
