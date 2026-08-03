"use client";

import { CheckIcon, ClipboardIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CopyStatus = "idle" | "copied" | "failed";
type CopyableValueVariant = "inline" | "command";

export function CopyableValue({
  value,
  label,
  children,
  className,
  variant = "inline",
}: {
  value: string;
  label: string;
  children?: React.ReactNode;
  className?: string;
  variant?: CopyableValueVariant;
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

  const icon =
    status === "copied" ? (
      <CheckIcon aria-hidden="true" />
    ) : (
      <ClipboardIcon aria-hidden="true" />
    );
  const statusMessage =
    status === "copied"
      ? "Copied"
      : status === "failed"
        ? "Copy failed"
        : "";

  if (variant === "command") {
    return (
      <div className={cn("relative", className)}>
        <code className="block whitespace-pre-wrap break-all pr-10">
          {children ?? value}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Copy ${label}`}
          onClick={() => void copy()}
          className="absolute top-3 right-3"
        >
          {icon}
          <span className="sr-only" aria-live="polite">
            {statusMessage}
          </span>
        </Button>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => void copy()}
      className={cn(
        "group/copy inline-flex max-w-full items-center gap-1 rounded-sm text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
        className,
      )}
    >
      <span className="truncate">{children ?? value}</span>
      <span
        aria-hidden="true"
        className="-translate-x-1 shrink-0 opacity-0 transition-[opacity,transform] duration-150 group-hover/copy:translate-x-0 group-hover/copy:opacity-100 group-focus-visible/copy:translate-x-0 group-focus-visible/copy:opacity-100 motion-reduce:transition-none [&_svg]:size-3"
      >
        {icon}
      </span>
      <span className="sr-only" aria-live="polite">
        {statusMessage}
      </span>
    </button>
  );
}
