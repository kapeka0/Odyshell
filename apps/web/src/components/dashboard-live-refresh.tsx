"use client";

import { useEffect } from "react";

type LiveToken = {
  token: string;
  expiresAt: string;
};

const RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;
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

async function consumeOrganizationEvents(
  serverUrl: string,
  token: string,
  signal: AbortSignal,
  refresh: () => Promise<boolean>,
  connected: () => void,
  delayed: () => void,
): Promise<void> {
  const response = await fetch(new URL("/v1/control/events", serverUrl), {
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
  onDelayedChange,
}: {
  refresh: () => Promise<boolean>;
  serverUrl: string;
  onDelayedChange: (delayed: boolean) => void;
}) {
  useEffect(() => {
    const controller = new AbortController();
    let retry: number | undefined;
    let retryDelay = RETRY_DELAY_MS;

    const connect = async (): Promise<void> => {
      try {
        const authorization = await liveToken(controller.signal);
        await consumeOrganizationEvents(
          serverUrl,
          authorization.token,
          controller.signal,
          refresh,
          () => {
            retryDelay = RETRY_DELAY_MS;
            onDelayedChange(false);
          },
          () => onDelayedChange(true),
        );
      } catch {
        if (controller.signal.aborted) return;
        onDelayedChange(true);
      }
      if (!controller.signal.aborted) {
        retry = window.setTimeout(() => void connect(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh().then((fresh) => {
          if (!fresh) onDelayedChange(true);
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
  }, [onDelayedChange, refresh, serverUrl]);

  return null;
}
