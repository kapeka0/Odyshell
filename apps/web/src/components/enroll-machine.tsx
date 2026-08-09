"use client";

import { BotIcon, KeyRoundIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { CopyableValue } from "@/components/copyable-value";
import { useDashboard } from "@/components/dashboard-provider";
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { formatDashboardTimestamp } from "@/lib/date-time";
import { machineEnrollmentCommand } from "@/lib/enrollment-command";

const machineNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a machine name")
  .max(64, "Use at most 64 characters")
  .regex(/^[a-zA-Z0-9._-]+$/, "Use letters, numbers, dots, dashes or underscores");

type EnrollmentToken = { token: string; expiresAt: string };

export function EnrollMachine({
  serverUrl,
  atLimit,
}: {
  serverUrl: string;
  atLimit: boolean;
}) {
  const { state } = useDashboard();
  const activeAgents = state.status === "ready"
    ? state.context.agents.filter((agent) => agent.status === "active")
    : [];
  const [machineName, setMachineName] = useState("my-machine");
  const [agentId, setAgentId] = useState("");
  const [enrollment, setEnrollment] = useState<EnrollmentToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selectedAgentId = agentId || undefined;
  const agentOptions = [
    { label: "No Agent yet", value: "none" },
    ...activeAgents.map((agent) => ({ label: agent.name, value: agent.id })),
  ];

  const command = enrollment
    ? machineEnrollmentCommand({
        serverUrl,
        token: enrollment.token,
        machineName,
        ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
      })
    : "";

  async function createEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedName = machineNameSchema.safeParse(machineName);
    if (!parsedName.success) {
      setNameError(parsedName.error.issues[0]?.message ?? "Invalid machine name");
      return;
    }
    setPending(true);
    setError(null);
    setNameError(null);
    try {
      const response = await fetch("/api/enrollment-token", { method: "POST" });
      const body = (await response.json()) as EnrollmentToken & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not create enrollment token");
      setEnrollment(body);
      toast.add({
        title: "Enrollment command ready",
        description: "The one-time token expires in ten minutes.",
        type: "success",
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create enrollment token");
      toast.add({
        title: "Enrollment was not created",
        description: "No Machine token was issued.",
        type: "error",
      });
    } finally {
      setPending(false);
    }
  }

  if (enrollment) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Run this command on {machineName}</CardTitle>
          <CardDescription>
            The command installs one outbound Client Profile. Its Local Policy
            {selectedAgentId ? " allows the selected Agent." : " starts with no allowed Agents."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <CopyableValue
            value={command}
            label="Machine enrollment command"
            variant="command"
            className="w-full rounded-xl border bg-muted/50 p-5 font-mono text-sm leading-6 text-foreground"
          />
          <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-6">
            <span className="text-xs text-muted-foreground">
              Expires{" "}
              {formatDashboardTimestamp(
                enrollment.expiresAt,
                state.status === "ready" ? state.context.userPreferences.timeZone : "System",
              )}
            </span>
            <Link href="/dashboard/machines" className={buttonVariants({ variant: "outline" })}>
              Done
            </Link>
          </div>
          <Alert>
            <KeyRoundIcon aria-hidden="true" />
            <AlertTitle>Shown once</AlertTitle>
            <AlertDescription>
              The enrollment token is consumed once and is never stored in Client configuration.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Machine</CardTitle>
        <CardDescription>
          Register the Linux host now. Allowing an Agent in its owner-controlled Local Policy is
          optional.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={createEnrollment}>
          <FieldGroup>
            <Field data-invalid={Boolean(nameError)}>
              <FieldLabel htmlFor="machine-name">Machine name</FieldLabel>
              <Input
                id="machine-name"
                autoComplete="off"
                spellCheck={false}
                value={machineName}
                onChange={(event) => {
                  setMachineName(event.target.value);
                  setNameError(null);
                }}
                aria-invalid={Boolean(nameError)}
              />
              <FieldError>{nameError}</FieldError>
            </Field>

            <Field>
              <FieldLabel htmlFor="machine-agent">Initial allowed Agent (optional)</FieldLabel>
              {activeAgents.length > 0 ? (
                <Select
                  items={agentOptions}
                  value={agentId || "none"}
                  onValueChange={(value) => {
                    setAgentId(value === "none" ? "" : (value ?? ""));
                  }}
                >
                  <SelectTrigger id="machine-agent" className="w-full">
                    <SelectValue placeholder="No Agent yet" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="none">No Agent yet</SelectItem>
                      {activeAgents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm text-muted-foreground">No Agents registered yet.</span>
                  <Link href="/dashboard/agents/add" className={buttonVariants({ variant: "outline" })}>
                    <BotIcon /> Register Agent
                  </Link>
                </div>
              )}
              <FieldDescription>
                With no Agent selected, the Machine connects but denies every Task locally.
              </FieldDescription>
            </Field>

            <Alert>
              <ShieldCheckIcon aria-hidden="true" />
              <AlertTitle>Conservative Local Policy</AlertTitle>
              <AlertDescription>
                One Task and one Command at a time, one-hour Task limit, ten-minute Command limit,
                1 MiB output ceiling, no sudo configuration, and human approval allowed.
              </AlertDescription>
            </Alert>

            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Could not create the command</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-wrap items-start justify-end gap-2 border-t pt-6">
              <Link href="/dashboard/machines" className={buttonVariants({ variant: "outline" })}>
                Cancel
              </Link>
              <Button type="submit" disabled={pending || atLimit}>
                {pending ? <Spinner /> : null}
                Add
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
