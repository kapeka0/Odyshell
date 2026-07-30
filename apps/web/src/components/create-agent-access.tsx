"use client";

import {
  agentTokenRequestSchema,
  type Capability,
} from "@odyshell/protocol";
import Link from "next/link";
import { useState } from "react";
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
import { useDashboard } from "@/components/dashboard-provider";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import {
  agentAccessDurations,
  capabilityGroups,
  isReadOnlyPreset,
  toggleReadOnlyPreset,
} from "@/lib/agent-access-options";
import { agentLoginCommand } from "@/lib/agent-command";
import type { CloudMachine } from "@/lib/cloud-api";

type IssuedAccess = {
  id: string;
  name: string;
  token: string;
  expiresAt: string;
};

type ValidationErrors = {
  name?: string;
  machines?: string;
  capabilities?: string;
};

export function CreateAgentAccess({
  machines,
  serverUrl,
  atLimit,
}: {
  machines: CloudMachine[];
  serverUrl: string;
  atLimit: boolean;
}) {
  const { refresh } = useDashboard();
  const [name, setName] = useState("");
  const [machineIds, setMachineIds] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [expiresInSeconds, setExpiresInSeconds] = useState(
    agentAccessDurations[0].value,
  );
  const [validation, setValidation] = useState<ValidationErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<IssuedAccess | null>(null);
  const readOnlyEnabled = isReadOnlyPreset(capabilities);
  const selectedDuration =
    agentAccessDurations.find(
      (duration) => duration.value === expiresInSeconds,
    ) ?? agentAccessDurations[0];

  async function createAccess(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const required: ValidationErrors = {
      name: name.trim() ? undefined : "Enter an access name",
      machines:
        machineIds.length > 0 ? undefined : "Select at least one machine",
      capabilities:
        capabilities.length > 0
          ? undefined
          : "Select at least one capability",
    };
    if (required.name || required.machines || required.capabilities) {
      setValidation(required);
      return;
    }
    const parsed = agentTokenRequestSchema.safeParse({
      name,
      machineIds,
      capabilities,
      expiresInSeconds,
    });
    if (!parsed.success) {
      const fields = parsed.error.flatten().fieldErrors;
      setValidation({
        name: fields.name?.[0] ?? "Check the access name",
        machines: fields.machineIds?.[0] ?? "Check the selected machines",
        capabilities:
          fields.capabilities?.[0] ?? "Check the selected capabilities",
      });
      return;
    }

    setPending(true);
    setValidation({});
    try {
      const response = await fetch("/api/agent-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = (await response.json().catch(() => ({}))) as IssuedAccess & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? "Could not create agent access");
      }
      setIssued(body);
      toast.add({
        title: "Agent created",
        description: "Copy the credential now. It will not be shown again.",
        type: "success",
      });
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not create agent access",
      );
      toast.add({
        title: "Agent was not created",
        description: "Review the form or try again.",
        type: "error",
      });
    } finally {
      setPending(false);
    }
  }

  if (issued) {
    const command = agentLoginCommand({
      serverUrl,
      token: issued.token,
    });
    return (
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>{issued.name} is ready</CardTitle>
          <CardDescription>
            This credential is shown once. Odyshell stores only its hash.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <Credential
            label="Credential"
            value={issued.token}
            copyLabel="Agent credential"
          />
          <Credential
            label="Command"
            value={command}
            copyLabel="Agent login command"
          />
          <div className="flex justify-end border-t pt-6">
            <Link
              href="/dashboard/agents"
              className={buttonVariants({ variant: "outline" })}
            >
              Done
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create agent</CardTitle>
        <CardDescription>
          Choose the machines, capabilities and lifetime this agent needs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={createAccess}>
          <FieldGroup>
            <Field data-invalid={Boolean(validation.name)}>
              <FieldLabel htmlFor="access-name">Name</FieldLabel>
              <Input
                id="access-name"
                name="access-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setValidation((current) => ({
                    ...current,
                    name: undefined,
                  }));
                }}
                placeholder="Deploy agent"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(validation.name)}
              />
              <FieldError>{validation.name}</FieldError>
            </Field>

            <FieldSet data-invalid={Boolean(validation.machines)}>
              <FieldLegend>Machines</FieldLegend>
              <div className="grid gap-2 sm:grid-cols-2">
                {machines.map((machine) => (
                  <Field
                    key={machine.id}
                    orientation="horizontal"
                    className="rounded-lg border p-3"
                  >
                    <Checkbox
                      id={`access-machine-${machine.id}`}
                      checked={machineIds.includes(machine.id)}
                      onCheckedChange={(checked) => {
                        setMachineIds((current) =>
                          checked
                            ? [...new Set([...current, machine.id])]
                            : current.filter((id) => id !== machine.id),
                        );
                        setValidation((current) => ({
                          ...current,
                          machines: undefined,
                        }));
                      }}
                      aria-invalid={Boolean(validation.machines)}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`access-machine-${machine.id}`}>
                        <FieldTitle>{machine.name}</FieldTitle>
                      </FieldLabel>
                      <FieldDescription>
                        {machine.online ? "Online" : "Offline"}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </div>
              {machines.length === 0 ? (
                <FieldDescription>
                  Connect a machine before creating access.
                </FieldDescription>
              ) : null}
              <FieldError>{validation.machines}</FieldError>
            </FieldSet>

            <FieldSet data-invalid={Boolean(validation.capabilities)}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <FieldLegend>Capabilities</FieldLegend>
                  <FieldDescription>
                    Nothing is selected by default.
                  </FieldDescription>
                </div>
                <Button
                  type="button"
                  variant={readOnlyEnabled ? "default" : "outline"}
                  size="sm"
                  aria-pressed={readOnlyEnabled}
                  onClick={() => {
                    setCapabilities(toggleReadOnlyPreset(capabilities));
                    setValidation((current) => ({
                      ...current,
                      capabilities: undefined,
                    }));
                  }}
                >
                  Read-only
                </Button>
              </div>
              <div className="grid gap-5 md:grid-cols-3">
                {capabilityGroups.map((group) => (
                  <div key={group.name} className="flex flex-col gap-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      {group.name}
                    </p>
                    {group.capabilities.map((capability) => (
                      <Field key={capability.value} orientation="horizontal">
                        <Checkbox
                          id={`access-${capability.value}`}
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
                            setValidation((current) => ({
                              ...current,
                              capabilities: undefined,
                            }));
                          }}
                          aria-invalid={Boolean(validation.capabilities)}
                        />
                        <FieldContent>
                          <FieldLabel htmlFor={`access-${capability.value}`}>
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
              <FieldError>{validation.capabilities}</FieldError>
            </FieldSet>

            <Field>
              <FieldLabel htmlFor="access-expiry">Expires in</FieldLabel>
              <Select
                value={String(expiresInSeconds)}
                onValueChange={(value) => {
                  const nextValue = Number(value);
                  if (Number.isFinite(nextValue)) {
                    setExpiresInSeconds(nextValue);
                  }
                }}
              >
                <SelectTrigger id="access-expiry" className="w-full sm:w-56">
                  <span className="flex-1 text-left">
                    {selectedDuration.label}
                  </span>
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectGroup>
                    {agentAccessDurations.map((duration) => (
                      <SelectItem
                        key={duration.value}
                        value={String(duration.value)}
                      >
                        {duration.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Could not create access</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex justify-end gap-2 border-t pt-6">
              <Link
                href="/dashboard/agents"
                className={buttonVariants({ variant: "outline" })}
              >
                Cancel
              </Link>
              <Button
                type="submit"
                disabled={pending || atLimit || machines.length === 0}
              >
                {pending ? (
                  <>
                    <Spinner />
                    Creating…
                  </>
                ) : (
                  "Create"
                )}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function Credential({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium">{label}</p>
      <CopyableValue
        value={value}
        label={copyLabel}
        wrap
        className="w-full rounded-lg bg-foreground p-4 font-mono text-xs leading-6 text-background"
      />
    </div>
  );
}
