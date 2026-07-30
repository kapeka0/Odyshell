"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  CheckIcon,
  CpuIcon,
  KeyRoundIcon,
  PauseIcon,
  PlayIcon,
  RadioIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";

const stages = [
  {
    label: "Agent request",
    icon: TerminalIcon,
    title: "Update the API dependency",
    detail: "process.exec · production-api",
  },
  {
    label: "Policy decision",
    icon: KeyRoundIcon,
    title: "Access allowed",
    detail: "scope valid · expires in 42 min",
  },
  {
    label: "Machine response",
    icon: RadioIcon,
    title: "Operation completed",
    detail: "exit 0 · 1.8 s",
  },
] as const;

export function ProductPreview() {
  const [stage, setStage] = useState(0);
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const paused = manuallyPaused || hovered;

  useEffect(() => {
    if (paused) return;
    const interval = window.setInterval(
      () => setStage((current) => (current + 1) % stages.length),
      2_400,
    );
    return () => window.clearInterval(interval);
  }, [paused]);

  const active = stages[stage];

  return (
    <figure
      aria-label="An agent request moving safely through Odyshell"
      className="relative flex h-full min-h-[34rem] overflow-hidden rounded-[2.5rem] border bg-muted/55 p-5 sm:p-8"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setHovered(true)}
      onBlurCapture={() => setHovered(false)}
    >
      <figcaption className="absolute top-6 left-6 flex items-center gap-2 text-xs text-muted-foreground sm:top-8 sm:left-8">
        <span className="size-2 rounded-full bg-[var(--color-success)]" />
        Live route
      </figcaption>
      <button
        type="button"
        className="absolute top-5 right-5 inline-flex size-9 items-center justify-center rounded-lg border bg-background text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 sm:top-7 sm:right-7"
        onClick={() => setManuallyPaused((current) => !current)}
        aria-label={manuallyPaused ? "Play route animation" : "Pause route animation"}
      >
        {manuallyPaused ? (
          <PlayIcon aria-hidden="true" className="size-4" />
        ) : (
          <PauseIcon aria-hidden="true" className="size-4" />
        )}
      </button>

      <div className="m-auto flex w-full max-w-md flex-col gap-3">
        <AnimatePresence mode="wait">
          <motion.div
            key={active.label}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.99 }}
            transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
            className="rounded-2xl border bg-card p-5 shadow-lg sm:p-6"
          >
            <div className="flex items-center justify-between gap-4">
              <span className="flex size-10 items-center justify-center rounded-xl border bg-background">
                <active.icon aria-hidden="true" className="size-5" />
              </span>
              <Badge variant={stage === 1 ? "default" : "outline"}>{active.label}</Badge>
            </div>
            <p className="mt-8 text-xl font-semibold tracking-[-0.02em]">{active.title}</p>
            <p className="mt-2 font-mono text-xs text-muted-foreground">{active.detail}</p>
            <div className="mt-6 h-1 overflow-hidden rounded-full bg-muted">
              <motion.div
                key={`progress-${stage}`}
                className="h-full origin-left bg-[var(--color-success)]"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 2.2, ease: "linear" }}
              />
            </div>
          </motion.div>
        </AnimatePresence>

        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <TerminalIcon aria-hidden="true" className="size-4" />
            Agent
          </div>
          <div className="h-px w-8 bg-border" />
          <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
            Machine
            <CpuIcon aria-hidden="true" className="size-4" />
          </div>
        </div>
      </div>

      <div className="absolute right-6 bottom-6 flex items-center gap-2 text-xs text-muted-foreground sm:right-8 sm:bottom-8">
        <CheckIcon aria-hidden="true" className="size-4 text-[var(--color-success)]" />
        No inbound port
      </div>
    </figure>
  );
}
