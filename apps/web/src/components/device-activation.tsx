"use client";

import { KeyRoundIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  deviceApprovalErrorPath,
  deviceCodeSchema,
} from "@/lib/device-activation";

export function DeviceActivation({ initialCode = "" }: { initialCode?: string }) {
  const router = useRouter();
  const [code, setCode] = useState(initialCode);
  const [pending, setPending] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = deviceCodeSchema.safeParse(code);
    if (!parsed.success) {
      setValidationError(
        parsed.error.issues[0]?.message ?? "Invalid device code",
      );
      return;
    }

    setPending(true);
    setValidationError(null);
    try {
      const response = await fetch("/api/device/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: parsed.data }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        approved?: boolean;
        error?: string;
      };

      if (!response.ok || !body.approved) {
        router.replace(deviceApprovalErrorPath(body.error));
        return;
      }

      router.replace("/activate/success");
    } catch {
      router.replace(deviceApprovalErrorPath("approval_failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field data-invalid={Boolean(validationError)}>
          <FieldLabel htmlFor="device-code">Device code</FieldLabel>
          <Input
            id="device-code"
            name="device-code"
            className="h-14 font-mono text-xl tracking-[0.16em] uppercase"
            inputMode="text"
            autoComplete="one-time-code"
            spellCheck={false}
            maxLength={9}
            placeholder="ABCD-EFGH"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-invalid={Boolean(validationError)}
            autoFocus={!initialCode}
          />
          {validationError ? (
            <FieldError>{validationError}</FieldError>
          ) : null}
        </Field>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? (
            <>
              <Spinner data-icon="inline-start" />
              Approving…
            </>
          ) : (
            <>
              <KeyRoundIcon data-icon="inline-start" />
              Approve CLI
            </>
          )}
        </Button>
        <Alert>
          <AlertTitle>Temporary browser approval</AlertTitle>
          <AlertDescription>
            This approves the CLI login request only. Agent access remains
            separately scoped and expiring.
          </AlertDescription>
        </Alert>
      </FieldGroup>
    </form>
  );
}
