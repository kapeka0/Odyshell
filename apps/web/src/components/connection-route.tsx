import { CheckIcon, LaptopIcon, RadioIcon, ServerIcon } from "lucide-react";

const nodes = [
  { label: "Agent", detail: "scoped token", icon: LaptopIcon },
  { label: "Odyshell", detail: "policy + relay", icon: ServerIcon },
  { label: "Machine", detail: "outbound client", icon: RadioIcon },
] as const;

export function ConnectionRoute() {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center">
      {nodes.map((node, index) => (
        <div key={node.label} className="contents">
          <div className="flex items-center gap-3 rounded-xl border border-white/14 bg-white/7 p-4">
            <node.icon aria-hidden="true" className="text-white/55" />
            <div>
              <p className="font-heading text-sm font-semibold">{node.label}</p>
              <p className="font-mono text-xs text-white/48">{node.detail}</p>
            </div>
            {index === nodes.length - 1 && <CheckIcon aria-label="Connected" className="ml-auto text-[var(--color-success)]" />}
          </div>
          {index < nodes.length - 1 && (
            <div aria-hidden="true" className="relative h-px min-w-8 overflow-hidden bg-white/18 sm:w-12">
              <span className="route-pulse absolute inset-0 bg-[var(--color-success)]" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
