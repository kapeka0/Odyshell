import {
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  CpuIcon,
  ServerIcon,
} from "lucide-react";
import { StatusBadge } from "@/components/status-badge";

const principals = [
  { label: "Agent", value: "release-agent", icon: BotIcon },
  { label: "Server", value: "policy matched", icon: ServerIcon },
  { label: "Machine", value: "production-api", icon: CpuIcon },
] as const;

export function AgentCommandTrace() {
  return (
    <figure
      aria-label="An Agent Command crossing Server and Machine policy"
      className="relative min-w-0 rounded-lg border border-white/14 bg-white/[0.045] p-4 shadow-2xl shadow-black/30 sm:p-6"
    >
      <figcaption className="flex items-center justify-between gap-4 border-b border-white/12 pb-4">
        <div>
          <p className="font-mono text-xs text-white/48">SESSION / DEPLOY-142</p>
          <p className="mt-1 text-sm font-medium text-white/88">Deploy customer API</p>
        </div>
        <StatusBadge status="active">Active</StatusBadge>
      </figcaption>

      <div className="mt-5 grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center">
        {principals.map((principal, index) => (
          <div key={principal.label} className="contents">
            <div className="rounded-lg border border-white/12 bg-black/18 p-3">
              <principal.icon aria-hidden="true" className="text-white/44" />
              <p className="mt-5 font-mono text-[0.6875rem] text-white/42 uppercase">
                {principal.label}
              </p>
              <p className="mt-1 truncate text-sm font-medium text-white/88">
                {principal.value}
              </p>
            </div>
            {index < principals.length - 1 ? (
              <div className="hidden items-center sm:flex" aria-hidden="true">
                <span className="agent-route-line h-px w-7 bg-white/18" />
                <ArrowRightIcon className="-ml-1 size-3 text-white/40" />
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-lg border border-white/12 bg-black/28 p-4">
        <div className="flex items-center justify-between gap-4 font-mono text-[0.6875rem] text-white/42 uppercase">
          <span>Command 03</span>
          <span>Timeout 120s</span>
        </div>
        <code className="mt-4 block overflow-x-auto font-mono text-sm leading-6 text-white/86">
          $ git pull --ff-only &amp;&amp; pnpm deploy
        </code>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <p className="flex items-center gap-2 text-xs text-white/58">
          <CheckIcon aria-hidden="true" className="size-4 text-status-success" />
          Server policy allowed
        </p>
        <p className="flex items-center gap-2 text-xs text-white/58">
          <CheckIcon aria-hidden="true" className="size-4 text-status-success" />
          Local Policy enforced
        </p>
      </div>

      <div className="mt-5 flex items-center justify-between gap-4 border-t border-white/12 pt-4 font-mono text-xs text-white/44">
        <span>same-user shell</span>
        <span>exit 0 · audited</span>
      </div>
    </figure>
  );
}
