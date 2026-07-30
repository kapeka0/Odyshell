"use client";

import { WifiOffIcon } from "lucide-react";
import { useEffect, useState } from "react";

type LiveToken = {
  token: string;
  expiresAt: string;
};

const RETRY_DELAY_MS = 2_000;
const FALLBACK_INTERVAL_MS = 30_000;

async function liveToken(signal: AbortSignal): Promise<LiveToken> {
  const response = await fetch("/api/dashboard/live-token", {
    method: "POST",
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("Live updates are unavailable");
  return (await response.json()) as LiveToken;
}

async function consumeWorkspaceEvents(
  serverUrl: string,
  token: string,
  signal: AbortSignal,
  refresh: () => Promise<boolean>,
  connected: () => void,
  delayed: () => void,
): Promise<void> {
  const response = await fetch(new URL("/v1/cloud/events", serverUrl), {
    method: "POST",
    body: token,
    headers: { "content-type": "text/plain" },
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error("Live updates are unavailable");
  }
  connected();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (event.split("\n").includes("event: refresh")) {
        if (!(await refresh())) delayed();
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export function DashboardLiveRefresh({
  refresh,
  serverUrl,
}: {
  refresh: () => Promise<boolean>;
  serverUrl: string;
}) {
  const [updatesDelayed, setUpdatesDelayed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let retry: number | undefined;

    const connect = async (): Promise<void> => {
      try {
        const authorization = await liveToken(controller.signal);
        await consumeWorkspaceEvents(
          serverUrl,
          authorization.token,
          controller.signal,
          refresh,
          () => setUpdatesDelayed(false),
          () => setUpdatesDelayed(true),
        );
      } catch {
        if (controller.signal.aborted) return;
        setUpdatesDelayed(true);
      }
      if (!controller.signal.aborted) {
        retry = window.setTimeout(() => void connect(), RETRY_DELAY_MS);
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh().then((fresh) => {
          if (!fresh) setUpdatesDelayed(true);
        });
      }
    };
    const interval = window.setInterval(
      refreshWhenVisible,
      FALLBACK_INTERVAL_MS,
    );
    window.addEventListener("focus", refreshWhenVisible);
    void connect();

    return () => {
      controller.abort();
      if (retry !== undefined) window.clearTimeout(retry);
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [refresh, serverUrl]);

  return updatesDelayed ? (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-30 flex items-center gap-2 rounded-full border bg-background px-3 py-2 text-xs text-muted-foreground shadow-sm"
    >
      <WifiOffIcon aria-hidden="true" className="size-3.5" />
      Live updates delayed
    </div>
  ) : null;
}
