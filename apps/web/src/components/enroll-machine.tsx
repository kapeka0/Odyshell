"use client";

import type { Capability } from "@odyshell/protocol";
import { KeyRoundIcon } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { CopyableValue } from "@/components/copyable-value";
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
  isFullAccessPreset,
  isReadOnlyPreset,
  toggleFullAccessPreset,
  toggleReadOnlyPreset,
} from "@/lib/agent-access-options";
import { machineEnrollmentCommand } from "@/lib/enrollment-command";

const machineNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a machine name")
  .max(64, "Use at most 64 characters")
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "Use letters, numbers, dots, dashes or underscores",
  );

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
  const readOnlyEnabled = isReadOnlyPreset(capabilities);
  const fullAccessEnabled = isFullAccessPreset(capabilities);

  const command = enrollment
    ? machineEnrollmentCommand({
        serverUrl,
        token: enrollment.token,
        machineName,
        capabilities,
      })
    : "";

  async function createEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

    try {
      const response = await fetch("/api/enrollment-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const body = (await response.json()) as EnrollmentToken & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? "Could not create enrollment token");
      }
      setEnrollment(body);
      toast.add({
        title: "Enrollment command ready",
        description: "The one-time token expires in ten minutes.",
        type: "success",
      });
    } catch (reason) {
      toast.add({
        title: "Enrollment was not created",
        description: "No machine token was issued.",
        type: "error",
      });
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not create enrollment token",
      );
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
            `ods up` enrolls a new identity or restarts the existing identity
            for this Odyshell server.
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
              {new Date(enrollment.expiresAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <Link
              href="/dashboard/machines"
              className={buttonVariants({ variant: "outline" })}
            >
              Done
            </Link>
          </div>
          <Alert>
            <KeyRoundIcon aria-hidden="true" />
            <AlertTitle>Shown once</AlertTitle>
            <AlertDescription>
              Machine enrollment is different from `ods login`. Login
              authorizes the CLI; this command connects the machine Client.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add machine</CardTitle>
        <CardDescription>
          Define the Client&apos;s local boundary, then generate its one-time
          connection command.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={createEnrollment}>
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
                aria-invalid={Boolean(nameError)}
              />
              <FieldError>{nameError}</FieldError>
            </Field>

            <FieldSet data-invalid={Boolean(capabilitiesError)}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <FieldLegend>Local capabilities</FieldLegend>
                  <FieldDescription>
                    The Client enforces this maximum policy on the machine.
                  </FieldDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant={readOnlyEnabled ? "default" : "outline"}
                    size="sm"
                    aria-pressed={readOnlyEnabled}
                    onClick={() => {
                      setCapabilities(toggleReadOnlyPreset(capabilities));
                      setCapabilitiesError(null);
                    }}
                  >
                    Read only
                  </Button>
                  <Button
                    type="button"
                    variant={fullAccessEnabled ? "default" : "outline"}
                    size="sm"
                    aria-pressed={fullAccessEnabled}
                    onClick={() => {
                      setCapabilities(toggleFullAccessPreset(capabilities));
                      setCapabilitiesError(null);
                    }}
                  >
                    Full access
                  </Button>
                </div>
              </div>
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {capabilityGroups.map((group) => (
                  <div key={group.name} className="flex flex-col gap-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      {group.name}
                    </p>
                    {group.capabilities.map((capability) => (
                      <Field key={capability.value} orientation="horizontal">
                        <Checkbox
                          id={`enroll-${capability.value}`}
                          checked={capabilities.includes(capability.value)}
                          onCheckedChange={(checked) => {
                            setCapabilities((current) =>
                              checked
                                ? [
                                    ...new Set([
                                      ...current,
                                      capability.value,
                                    ]),
                                  ]
                                : current.filter(
                                    (value) => value !== capability.value,
                                  ),
                            );
                            setCapabilitiesError(null);
                          }}
                          aria-invalid={Boolean(capabilitiesError)}
                        />
                        <FieldContent>
                          <FieldLabel
                            htmlFor={`enroll-${capability.value}`}
                          >
                            <FieldTitle>{capability.label}</FieldTitle>
                          </FieldLabel>
                          <FieldDescription>
                            {capability.description}
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                    ))}
                  </div>
                ))}
              </div>
              <FieldError>{capabilitiesError}</FieldError>
            </FieldSet>

            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Could not create the command</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-wrap items-start justify-end gap-2 border-t pt-6">
              <Link
                href="/dashboard/machines"
                className={buttonVariants({ variant: "outline" })}
              >
                Cancel
              </Link>
              <div className="flex flex-col items-end gap-1">
                <Button type="submit" disabled={pending || atLimit}>
                  {pending ? <Spinner /> : null}
                  Add
                </Button>
                {atLimit ? (
                  <p className="text-xs text-destructive">
                    Machine limit reached
                  </p>
                ) : null}
              </div>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
