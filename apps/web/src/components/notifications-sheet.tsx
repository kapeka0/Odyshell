"use client";

import { BellIcon, CheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDashboard } from "@/components/dashboard-provider";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";
import type { CloudNotification } from "@/lib/cloud-api";
import { cn } from "@/lib/utils";

export function NotificationsSheet() {
  const { state, refresh } = useDashboard();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const notifications = state.status === "ready" ? state.context.notifications : [];
  const unread = notifications.filter((notification) => !notification.readAt);

  async function markRead(notification: CloudNotification) {
    if (notification.readAt || pending) return;
    setPending(notification.id);
    try {
      const response = await fetch(`/api/notifications/${notification.id}/read`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("notification_read_failed");
      await refresh();
    } catch {
      toast.add({ title: "Notification could not be updated", type: "error" });
    } finally {
      setPending(null);
    }
  }

  async function openNotification(notification: CloudNotification) {
    await markRead(notification);
    setOpen(false);
    router.push(notification.href);
  }

  async function markAll() {
    if (unread.length === 0 || pending) return;
    setPending("all");
    try {
      const response = await fetch("/api/notifications/read-all", { method: "POST" });
      if (!response.ok) throw new Error("notification_read_failed");
      await refresh();
    } catch {
      toast.add({ title: "Notifications could not be updated", type: "error" });
    } finally {
      setPending(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={unread.length > 0 ? `${unread.length} unread notifications` : "Notifications"}
          />
        }
      >
        <BellIcon aria-hidden="true" />
        {unread.length > 0 ? (
          <span className="absolute right-1.5 top-1.5 size-2" aria-hidden="true">
            <span className="absolute inset-0 rounded-full bg-destructive/70 motion-safe:animate-ping" />
            <span className="relative block size-2 rounded-full bg-destructive" />
          </span>
        ) : null}
      </SheetTrigger>
      <SheetContent className="gap-0 sm:max-w-md">
        <SheetHeader className="border-b p-5 pr-14">
          <div className="flex items-center justify-between gap-4">
            <SheetTitle>Notifications</SheetTitle>
            {unread.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending !== null}
                onClick={() => void markAll()}
              >
                Mark all
              </Button>
            ) : null}
          </div>
          <SheetDescription>Updates that need your attention.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {notifications.length === 0 ? (
            <p className="px-3 py-12 text-center text-sm text-muted-foreground">
              You&apos;re all caught up.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {notifications.map((notification) => (
                <li key={notification.id}>
                  <div
                    className={cn(
                      "group flex items-start gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/60",
                      !notification.readAt && "bg-muted/35",
                    )}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => void openNotification(notification)}
                    >
                      <span className="block truncate text-sm font-medium">
                        {notification.title}
                      </span>
                      <span
                        className="mt-1 block text-xs text-muted-foreground"
                        suppressHydrationWarning
                      >
                        {relativeTime(notification.createdAt)}
                      </span>
                    </button>
                    {!notification.readAt ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={pending !== null}
                        aria-label={`Mark ${notification.title} as read`}
                        onClick={() => void markRead(notification)}
                      >
                        <CheckIcon aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1_000));
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (seconds < 60) return formatter.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.round(hours / 24), "day");
}
