"use client";

import type { Capability } from "@odyshell/protocol";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import {
  capabilityGroups,
  readOnlyCapabilities,
} from "@/lib/agent-access-options";
import { DEFAULT_CLOUD_SERVER_URL } from "@/lib/cloud-api";

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
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [enrollment, setEnrollment] = useState<EnrollmentToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  const serverArgument =
    serverUrl === DEFAULT_CLOUD_SERVER_URL ? "" : ` --server ${serverUrl}`;
  const command = enrollment
    ? `ods${serverArgument} up --token ${enrollment.token} --name ${machineName} --workspace . --allow ${capabilities.join(",")}`
    : "";

  async function createEnrollment() {
    const parsedName = machineNameSchema.safeParse(machineName);
    if (!parsedName.success) {
      setNameError(
        parsedName.error.issues[0]?.message ?? "Invalid machine name",
      );
      return;
    }
    if (capabilities.length === 0) {
      setCapabilitiesError("Select at least one local capability");
      return;
    }
    setPending(true);
    setError(null);
    setNameError(null);
    setCapabilitiesError(null);
    setEnrollment(null);
    const progressToast = toast.add({
      title: "Creating enrollment",
      description: "Issuing a one-time machine token.",
      type: "loading",
    });
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
      toast.close(progressToast);
      toast.add({
        title: "Enrollment command ready",
        description: "The one-time token expires in ten minutes.",
        type: "success",
      });
    } catch (reason) {
      toast.close(progressToast);
      toast.add({
        title: "Enrollment was not created",
        description: "No machine token was issued.",
        type: "error",
      });
      setError(reason instanceof Error ? reason.message : "Could not create enrollment token");
    } finally {
      setPending(false);
    }
  }

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    toast.add({
      title: "Command copied",
      description: "Run it on the machine you want to connect.",
      type: "success",
    });
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
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <Field data-invalid={Boolean(nameError)}>
            <FieldLabel htmlFor="machine-name">Machine name</FieldLabel>
            <Input
              id="machine-name"
              name="machine-name"
              autoComplete="off"
              spellCheck={false}
              value={machineName}
              onChange={(event) => {
                setMachineName(event.target.value);
                setNameError(null);
              }}
              disabled={Boolean(enrollment)}
              aria-invalid={Boolean(nameError)}
            />
            <FieldError>{nameError}</FieldError>
          </Field>
          <FieldSet
            disabled={Boolean(enrollment)}
            data-invalid={Boolean(capabilitiesError)}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <FieldLegend>Local capabilities</FieldLegend>
                <FieldDescription>
                  The Client enforces this maximum policy on the machine.
                </FieldDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setCapabilities(readOnlyCapabilities);
                  setCapabilitiesError(null);
                }}
                disabled={Boolean(enrollment)}
              >
                Select read-only
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {capabilityGroups.map((group) => (
                <div key={group.name} className="flex flex-col gap-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {group.name}
                  </p>
                  {group.capabilities.map((capability) => (
                    <Field key={capability.value} orientation="horizontal">
                      <Checkbox
                        id={`enroll-${capability.value}`}
                        checked={capabilities.includes(capability.value)}
                        onCheckedChange={(checked) =>
                          {
                            setCapabilities((current) =>
                              checked
                                ? [...new Set([...current, capability.value])]
                                : current.filter(
                                    (value) => value !== capability.value,
                                  ),
                            );
                            setCapabilitiesError(null);
                          }
                        }
                        aria-invalid={Boolean(capabilitiesError)}
                      />
                      <FieldContent>
                        <FieldLabel htmlFor={`enroll-${capability.value}`}>
                          <FieldTitle>{capability.label}</FieldTitle>
                        </FieldLabel>
                      </FieldContent>
                    </Field>
                  ))}
                </div>
              ))}
            </div>
            <FieldError>{capabilitiesError}</FieldError>
          </FieldSet>
        </FieldGroup>
        {!enrollment ? (
          <Button
            className="w-full sm:w-auto"
            onClick={createEnrollment}
            disabled={pending || atLimit}
          >
            <PlusIcon data-icon="inline-start" />
            {pending ? <><Spinner />Creating…</> : atLimit ? "Machine limit reached" : "Generate command"}
          </Button>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-md bg-foreground p-4 text-background">
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
              <KeyRoundIcon aria-hidden="true" />
              <AlertTitle>Shown once</AlertTitle>
              <AlertDescription>
                Run this command from the directory the Client may expose. The
                one-time token expires in ten minutes.
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
