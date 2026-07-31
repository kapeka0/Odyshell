"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";

export function AgentActivation({
  code,
  agentName,
}: {
  code: string;
  agentName: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function approve() {
    setPending(true);
    try {
      const response = await fetch("/api/agent-device/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!response.ok) {
        router.replace("/activate-agent/error");
        return;
      }
      router.replace("/activate-agent/success");
    } catch {
      router.replace("/activate-agent/error");
    } finally {
      setPending(false);
    }
  }

  return (
    <FieldGroup>
      <Alert>
        <AlertTitle>{agentName}</AlertTitle>
        <AlertDescription>
          Registers a persistent Agent identity in this workspace. It receives
          no machine access until a Session is approved.
        </AlertDescription>
      </Alert>
      <Button type="button" size="lg" disabled={pending} onClick={approve}>
        {pending ? <Spinner /> : null}
        {pending ? "Approving…" : "Approve"}
      </Button>
    </FieldGroup>
  );
}
