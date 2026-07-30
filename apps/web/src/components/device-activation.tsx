"use client";

import { ArrowRightIcon, CheckCircle2Icon, KeyRoundIcon } from "lucide-react";
import Link from "next/link";
import { FormEvent, useState } from "react";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const codeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase().replaceAll("-", ""))
  .pipe(z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/, "Enter the 8-character code shown by ods"));

export function DeviceActivation({ initialCode = "" }: { initialCode?: string }) {
  const [code, setCode] = useState(initialCode);
  const [pending, setPending] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = codeSchema.safeParse(code);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid device code");
      return;
    }
    setPending(true);
    setError(null);
    const progressToast = toast.add({
      title: "Approving CLI",
      description: "Binding this device code to the active workspace.",
      type: "loading",
    });
    try {
      const response = await fetch("/api/device/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: parsed.data }),
      });
      const body = (await response.json()) as { approved?: boolean; error?: string };
      if (!response.ok || !body.approved) {
        throw new Error(deviceErrorMessage(body.error));
      }
      setApproved(true);
      toast.close(progressToast);
      toast.add({
        title: "CLI approved",
        description: "The terminal can now finish signing in to this workspace.",
        type: "success",
      });
    } catch (reason) {
      toast.close(progressToast);
      toast.add({
        title: "CLI approval failed",
        description: "No CLI credential was issued.",
        type: "error",
      });
      setError(reason instanceof Error ? reason.message : "Could not approve this CLI");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-xl">
      <CardHeader>
        <CardTitle>{approved ? "CLI connected" : "Activate Odyshell CLI"}</CardTitle>
        <CardDescription>
          {approved
            ? "This CLI now has access to the active workspace."
            : "Confirm the code printed by ods. Approval never shares your Clerk session with the CLI."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {approved ? (
          <div className="flex flex-col gap-5">
            <Alert>
              <CheckCircle2Icon aria-hidden="true" className="text-[var(--color-success)]" />
              <AlertTitle>Access approved</AlertTitle>
              <AlertDescription>You can return to your terminal. Login will finish automatically.</AlertDescription>
            </Alert>
            <Link className={cn(buttonVariants({ size: "lg" }), "w-full sm:w-auto")} href="/dashboard">
              Open dashboard
              <ArrowRightIcon data-icon="inline-end" />
            </Link>
          </div>
        ) : (
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="device-code">
                Device code
                </FieldLabel>
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
                  aria-invalid={Boolean(error)}
                />
              </Field>
              <Button className="w-full" size="lg" disabled={pending}>
                <KeyRoundIcon data-icon="inline-start" />
                {pending ? <><Spinner />Approving…</> : "Approve CLI"}
              </Button>
              {error ? (
                <Alert variant="destructive">
                  <AlertTitle>Approval failed</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function deviceErrorMessage(code?: string): string {
  switch (code) {
    case "device_code_not_found":
      return "This code does not exist. Check the terminal and try again.";
    case "device_code_expired":
      return "This code expired. Run ods login again to create a new one.";
    case "device_code_already_used":
      return "This code was already used. Run ods login again if the terminal did not finish.";
    case "organization_admin_required":
      return "Only an organization administrator can approve CLI access.";
    default:
      return "Could not approve this CLI. Try again.";
  }
}
