"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  agentPolicyErrorPath,
  type AgentPolicyApproval,
} from "@/lib/agent-policy";

export function AgentPolicyApprovalForm({
  code,
  policy,
}: {
  code: string;
  policy: AgentPolicyApproval;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function approve() {
    setPending(true);
    try {
      const response = await fetch("/api/agent-policies/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        approved?: boolean;
        error?: string;
      };
      if (!response.ok || !body.approved) {
        router.replace(agentPolicyErrorPath(body.error));
        return;
      }
      router.replace("/policies/approve/success");
    } catch {
      router.replace(agentPolicyErrorPath());
    } finally {
      setPending(false);
    }
  }

  return (
    <FieldGroup>
      <Alert>
        <AlertTitle>{policy.agent.name}</AlertTitle>
        <AlertDescription>
          Sessions inside this ceiling can be approved automatically until the
          policy expires.
        </AlertDescription>
      </Alert>
      <div className="flex flex-col gap-3">
        {policy.scopes.map((scope) => (
          <div className="rounded-lg border p-3" key={scope.machineId}>
            <p className="text-sm font-medium">{scope.machine.name}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {scope.capabilities.map((capability) => (
                <Badge key={capability} variant="secondary">
                  {capability}
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-3 text-sm">
        <dt className="text-muted-foreground">Max duration</dt>
        <dd>{formatDuration(policy.maxSessionSeconds)}</dd>
        <dt className="text-muted-foreground">Valid until</dt>
        <dd>{new Date(policy.expiresAt).toLocaleString()}</dd>
        <dt className="text-muted-foreground">Version</dt>
        <dd>{policy.version}</dd>
      </dl>
      <Separator />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => router.push("/dashboard")}
        >
          Cancel
        </Button>
        <Button type="button" disabled={pending} onClick={approve}>
          {pending ? <Spinner /> : null}
          {pending ? "Approving…" : "Approve"}
        </Button>
      </div>
    </FieldGroup>
  );
}

function formatDuration(seconds: number): string {
  const hours = seconds / 3600;
  return Number.isInteger(hours)
    ? `${hours} ${hours === 1 ? "hour" : "hours"}`
    : `${Math.ceil(seconds / 60)} minutes`;
}
