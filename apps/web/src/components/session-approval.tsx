"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { HostShellWarning } from "@/components/host-shell-warning";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { SessionApproval } from "@/lib/session-approval";
import { sessionApprovalErrorPath } from "@/lib/session-approval";
import { executionWarningState } from "@/lib/host-shell-access";

export function SessionApprovalForm({
  requestId,
  approval,
}: {
  requestId: string;
  approval: SessionApproval;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const hostShellRequested = approval.scopes.some((scope) =>
    executionWarningState(
      scope.capabilities,
      scope.machine.privilegeEscalation,
    ).hostShell,
  );
  const rootAccessPossible = approval.scopes.some(
    (scope) => executionWarningState(
      scope.capabilities,
      scope.machine.privilegeEscalation,
    ).rootAccess,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await decide("approve");
  }

  async function decide(decision: "approve" | "deny") {
    setPending(decision);
    try {
      const response = await fetch(`/api/session-requests/${decision}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        approved?: boolean;
        denied?: boolean;
        error?: string;
      };
      if (
        !response.ok ||
        (decision === "approve" ? !body.approved : !body.denied)
      ) {
        router.replace(sessionApprovalErrorPath(body.error));
        return;
      }
      router.replace(`/sessions/approve/success?decision=${decision}`);
    } catch {
      router.replace(sessionApprovalErrorPath());
    } finally {
      setPending(null);
    }
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <dl className="space-y-3 text-sm">
        <ApprovalRow label="Agent" value={approval.agent.name} />
        <ApprovalRow label="Task" value={approval.title} />
        {approval.predecessorSessionId ? (
          <ApprovalRow
            label="Replaces"
            value={
              <code className="break-all font-mono text-xs">
                {approval.predecessorSessionId}
              </code>
            }
          />
        ) : null}
        <div className="space-y-3">
          {approval.scopes.map((scope) => (
            <div className="rounded-lg border p-3" key={scope.machineId}>
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{scope.machine.name}</span>
                <Badge variant={scope.readiness.ready ? "secondary" : "outline"}>
                  {scope.readiness.ready ? "Ready" : "Offline"}
                </Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {scope.capabilities.map((capability) => (
                  <Badge key={capability} variant="secondary">
                    {capability}
                  </Badge>
                ))}
              </div>
              <ScopeRestrictions scope={scope} />
            </div>
          ))}
        </div>
        <ApprovalRow
          label="Duration"
          value={formatDuration(approval.durationSeconds)}
        />
        <ApprovalRow
          label="Approve by"
          value={new Date(approval.expiresAt).toLocaleString()}
        />
      </dl>
      {hostShellRequested ? <HostShellWarning /> : null}
      {rootAccessPossible ? (
        <Alert>
          <AlertTitle>Root access possible</AlertTitle>
          <AlertDescription>
            This machine allows passwordless sudo during the Session.
          </AlertDescription>
        </Alert>
      ) : null}
      <Separator />
      <p className="text-sm text-muted-foreground">{approval.purpose}</p>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending !== null || approval.status !== "pending"}
          onClick={() => void decide("deny")}
        >
          {pending === "deny" ? "Denying…" : "Deny"}
        </Button>
        <Button
          type="submit"
          disabled={pending !== null || approval.status !== "pending"}
        >
          {pending === "approve" ? "Approving…" : "Approve"}
        </Button>
      </div>
    </form>
  );
}

function ScopeRestrictions({
  scope,
}: {
  scope: SessionApproval["scopes"][number];
}) {
  const paths = scope.restrictions.filesystem?.paths ?? [];
  const programs = scope.restrictions.process?.programs ?? [];
  const containers = scope.restrictions.docker?.containers ?? [];
  return (
    <div className="mt-3 space-y-1 text-xs text-muted-foreground">
      {paths.map((restriction) => (
        <code className="block break-all font-mono" key={`${restriction.path}:${restriction.includeDescendants}`}>
          {restriction.path}
          {restriction.includeDescendants ? "/**" : ""}
        </code>
      ))}
      {programs.map((rule) => (
        <code className="block break-all font-mono" key={`${rule.program}:${JSON.stringify(rule.args)}`}>
          {[rule.program, ...rule.args].join(" ")}
        </code>
      ))}
      {containers.map((container) => (
        <code className="block break-all font-mono" key={container}>
          {container}
        </code>
      ))}
    </div>
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
