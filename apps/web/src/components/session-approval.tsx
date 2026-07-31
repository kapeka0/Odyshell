"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { SessionApproval } from "@/lib/session-approval";
import { sessionApprovalErrorPath } from "@/lib/session-approval";

export function SessionApprovalForm({
  code,
  approval,
}: {
  code: string;
  approval: SessionApproval;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const response = await fetch("/api/session-requests/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        approved?: boolean;
        error?: string;
      };
      if (!response.ok || !body.approved) {
        router.replace(sessionApprovalErrorPath(body.error));
        return;
      }
      router.replace("/sessions/approve/success");
    } catch {
      router.replace(sessionApprovalErrorPath());
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <dl className="space-y-3 text-sm">
        <ApprovalRow label="Agent" value={approval.agent.name} />
        <ApprovalRow label="Machine" value={approval.machine.name} />
        <ApprovalRow
          label="Capability"
          value={<Badge variant="secondary">Read</Badge>}
        />
        <ApprovalRow
          label="Path"
          value={
            <code className="max-w-64 break-all rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs">
              {approval.path}
            </code>
          }
        />
        <ApprovalRow
          label="Expires"
          value={formatDuration(approval.durationSeconds)}
        />
      </dl>
      <Separator />
      <p className="text-sm text-muted-foreground">{approval.purpose}</p>
      <div className="flex justify-end">
        <Button type="submit" disabled={pending || approval.status !== "pending"}>
          {pending ? "Approving…" : "Approve"}
        </Button>
      </div>
    </form>
  );
}

function ApprovalRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[6rem_1fr] items-start gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium">{value}</dd>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${Math.ceil(seconds / 60)} minutes`;
}
