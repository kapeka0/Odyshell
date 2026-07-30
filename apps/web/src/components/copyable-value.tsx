"use client";

import { CheckIcon, ClipboardIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type CopyStatus = "idle" | "copied" | "failed";

export function CopyableValue({
  value,
  label,
  children,
  className,
  wrap = false,
}: {
  value: string;
  label: string;
  children?: React.ReactNode;
  className?: string;
  wrap?: boolean;
}) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (resetTimer.current !== undefined) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    if (resetTimer.current !== undefined) {
      window.clearTimeout(resetTimer.current);
    }
    resetTimer.current = window.setTimeout(() => setStatus("idle"), 1_500);
  }

  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => void copy()}
      className={cn(
        "group/copy inline-flex max-w-full items-center gap-1 rounded-sm text-left transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
        className,
      )}
    >
      <span className={wrap ? "whitespace-pre-wrap break-all" : "truncate"}>
        {children ?? value}
      </span>
      <span
        aria-hidden="true"
        className="-translate-x-1 shrink-0 opacity-0 transition-[opacity,transform] duration-150 group-hover/copy:translate-x-0 group-hover/copy:opacity-100 group-focus-visible/copy:translate-x-0 group-focus-visible/copy:opacity-100 motion-reduce:transition-none [&_svg]:size-3"
      >
        {status === "copied" ? <CheckIcon /> : <ClipboardIcon />}
      </span>
      <span className="sr-only" aria-live="polite">
        {status === "copied"
          ? "Copied"
          : status === "failed"
            ? "Copy failed"
            : ""}
      </span>
    </button>
  );
}
