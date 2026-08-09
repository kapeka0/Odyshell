"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

export default function OAuthConsentPage() {
  return (
    <Suspense fallback={<ConsentFallback />}>
      <ConsentDecision />
    </Suspense>
  );
}

function ConsentDecision() {
  const searchParams = useSearchParams();
  const [pending, setPending] = useState<"accept" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(accept: boolean) {
    setPending(accept ? "accept" : "deny");
    setError(null);
    const result = await authClient.oauth2.consent({
      accept,
      oauth_query: searchParams.toString(),
    });
    if (result.error) {
      setError(result.error.message ?? "The authorization decision failed.");
      setPending(null);
      return;
    }
    if (result.data?.url) window.location.assign(result.data.url);
  }

  return (
    <AuthShell
      title="Authorize Odyshell access"
      description="Allow this Agent or CLI to act through your active organization. Odyshell policies remain authoritative."
    >
      <div className="flex flex-col gap-4">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={pending !== null} onClick={() => void decide(false)}>
            {pending === "deny" ? <Spinner data-icon="inline-start" /> : null}
            Deny
          </Button>
          <Button disabled={pending !== null} onClick={() => void decide(true)}>
            {pending === "accept" ? <Spinner data-icon="inline-start" /> : null}
            Authorize
          </Button>
        </div>
      </div>
    </AuthShell>
  );
}

function ConsentFallback() {
  return (
    <AuthShell
      title="Authorize Agent access"
      description="Loading the OAuth authorization request."
    >
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    </AuthShell>
  );
}
