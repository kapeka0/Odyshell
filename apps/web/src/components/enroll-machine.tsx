"use client";

import { CheckIcon, CopyIcon, KeyRoundIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const machineNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a machine name")
  .max(64, "Use at most 64 characters")
  .regex(/^[a-zA-Z0-9._-]+$/, "Use letters, numbers, dots, dashes or underscores");

type EnrollmentToken = {
  token: string;
  expiresAt: string;
};

export function EnrollMachine({
  serverUrl,
  atLimit,
}: {
  serverUrl: string;
  atLimit: boolean;
}) {
  const [machineName, setMachineName] = useState("my-machine");
  const [enrollment, setEnrollment] = useState<EnrollmentToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  const command = enrollment
    ? `ods --server ${serverUrl} up --token ${enrollment.token} --name ${machineName}`
    : "";

  async function createEnrollment() {
    const parsedName = machineNameSchema.safeParse(machineName);
    if (!parsedName.success) {
      setError(parsedName.error.issues[0]?.message ?? "Invalid machine name");
      return;
    }
    setPending(true);
    setError(null);
    setEnrollment(null);
    try {
      const response = await fetch("/api/enrollment-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const body = (await response.json()) as EnrollmentToken & { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? "Could not create enrollment token");
      }
      setEnrollment(body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create enrollment token");
    } finally {
      setPending(false);
    }
  }

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a machine</CardTitle>
        <CardDescription>
          Generate a one-time command, then run it on the machine you want to expose to agents.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="machine-name">
            Machine name
          </label>
          <Input
            id="machine-name"
            autoComplete="off"
            value={machineName}
            onChange={(event) => setMachineName(event.target.value)}
            disabled={Boolean(enrollment)}
          />
        </div>
        {!enrollment ? (
          <Button
            className="w-full sm:w-auto"
            onClick={createEnrollment}
            disabled={pending || atLimit}
          >
            <PlusIcon data-icon="inline-start" />
            {pending ? "Creating…" : atLimit ? "Machine limit reached" : "Generate command"}
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="overflow-x-auto rounded-[var(--radius-control)] bg-[var(--color-graphite)] p-4 text-[var(--color-graphite-ink)]">
              <code className="whitespace-pre font-mono text-xs">{command}</code>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={copyCommand}>
                {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
                {copied ? "Copied" : "Copy command"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Expires {new Date(enrollment.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <Alert>
              <KeyRoundIcon />
              <AlertTitle>Shown once</AlertTitle>
              <AlertDescription>
                This enrollment token expires in ten minutes and cannot be reused.
              </AlertDescription>
            </Alert>
          </div>
        )}
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not create the command</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
