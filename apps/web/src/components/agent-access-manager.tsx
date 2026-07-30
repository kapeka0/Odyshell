"use client";

import {
  agentTokenRequestSchema,
  type Capability,
} from "@odyshell/protocol";
import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { Separator } from "@/components/ui/separator";
import {
  agentAccessDurations,
  capabilityGroups,
  readOnlyCapabilities,
} from "@/lib/agent-access-options";
import type { AgentAccess, CloudMachine } from "@/lib/cloud-api";

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

export function AgentAccessManager({
  machines,
  accesses,
  atLimit,
}: {
  machines: CloudMachine[];
  accesses: AgentAccess[];
  atLimit: boolean;
}) {
  const router = useRouter();
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
  const [copied, setCopied] = useState(false);

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
      const flattened = parsed.error.flatten().fieldErrors;
      setValidation({
        name: flattened.name?.[0] ?? "Check the access name",
        machines: flattened.machineIds?.[0] ?? "Check the selected machines",
        capabilities:
          flattened.capabilities?.[0] ?? "Check the selected capabilities",
      });
      return;
    }

    setPending(true);
    setError(null);
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
        throw new Error(body.error ?? "Could not create Agent Access");
      }
      setIssued(body);
      setName("");
      setMachineIds([]);
      setCapabilities([]);
      setExpiresInSeconds(agentAccessDurations[0].value);
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not create Agent Access",
      );
    } finally {
      setPending(false);
    }
  }

  async function copyToken() {
    if (!issued) return;
    await navigator.clipboard.writeText(issued.token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent Access</CardTitle>
        <CardDescription>
          Issue scoped, temporary credentials for agents. The Client still
          enforces its local capability policy.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">
            {accesses.filter((access) => access.status === "active").length}{" "}
            active
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-6">
        {issued ? (
          <Alert>
            <KeyRoundIcon />
            <AlertTitle>{issued.name} is ready</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                Copy this credential now. Odyshell stores only its hash and
                cannot show it again.
              </p>
              <div className="overflow-x-auto rounded-[var(--radius-control)] bg-[var(--color-graphite)] p-3 text-[var(--color-graphite-ink)]">
                <code className="whitespace-pre font-mono text-xs">
                  {issued.token}
                </code>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={copyToken}>
                  {copied ? (
                    <CheckIcon data-icon="inline-start" />
                  ) : (
                    <CopyIcon data-icon="inline-start" />
                  )}
                  {copied ? "Copied" : "Copy credential"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setIssued(null)}
                >
                  Create another
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={createAccess}>
            <FieldGroup>
              <Field data-invalid={Boolean(validation.name)}>
                <FieldLabel htmlFor="access-name">Access name</FieldLabel>
                <Input
                  id="access-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setValidation((current) => ({
                      ...current,
                      name: undefined,
                    }));
                  }}
                  placeholder="deploy-agent"
                  autoComplete="off"
                  aria-invalid={Boolean(validation.name)}
                />
                <FieldDescription>
                  Use a name that identifies the agent or automation.
                </FieldDescription>
                <FieldError>{validation.name}</FieldError>
              </Field>

              <FieldSet data-invalid={Boolean(validation.machines)}>
                <FieldLegend>Machines</FieldLegend>
                <FieldDescription>
                  Select one or more existing machines. Future machines are
                  never included automatically.
                </FieldDescription>
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
                      Nothing is selected by default. Grant only what the task
                      needs.
                    </FieldDescription>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setCapabilities(readOnlyCapabilities);
                      setValidation((current) => ({
                        ...current,
                        capabilities: undefined,
                      }));
                    }}
                  >
                    Select read-only
                  </Button>
                </div>
                <div className="grid gap-5 md:grid-cols-3">
                  {capabilityGroups.map((group) => (
                    <div key={group.name} className="space-y-3">
                      <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
                        {group.name}
                      </p>
                      {group.capabilities.map((capability) => (
                        <Field
                          key={capability.value}
                          orientation="horizontal"
                        >
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
                                      (value) =>
                                        value !== capability.value,
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
                            <FieldLabel
                              htmlFor={`access-${capability.value}`}
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
                <FieldError>{validation.capabilities}</FieldError>
              </FieldSet>

              <FieldSet>
                <FieldLegend>Expires after</FieldLegend>
                <FieldDescription>
                  Access stops automatically at this time. It can also be
                  revoked immediately.
                </FieldDescription>
                <div className="flex flex-wrap gap-2">
                  {agentAccessDurations.map((duration) => (
                    <Button
                      key={duration.value}
                      type="button"
                      size="sm"
                      variant={
                        expiresInSeconds === duration.value
                          ? "default"
                          : "outline"
                      }
                      aria-pressed={expiresInSeconds === duration.value}
                      onClick={() => setExpiresInSeconds(duration.value)}
                    >
                      {duration.label}
                    </Button>
                  ))}
                </div>
              </FieldSet>

              {error ? (
                <Alert variant="destructive">
                  <AlertTitle>Could not create access</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}

              <Button
                type="submit"
                disabled={
                  pending ||
                  atLimit ||
                  machines.length === 0
                }
              >
                <ShieldCheckIcon data-icon="inline-start" />
                {pending
                  ? "Creating…"
                  : atLimit
                    ? "Access limit reached"
                    : "Create Agent Access"}
              </Button>
            </FieldGroup>
          </form>
        )}

        <Separator />
        <AccessList accesses={accesses} machines={machines} />
      </CardContent>
    </Card>
  );
}

function AccessList({
  accesses,
  machines,
}: {
  accesses: AgentAccess[];
  machines: CloudMachine[];
}) {
  if (accesses.length === 0) {
    return (
      <Empty className="min-h-40 border-y">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <KeyRoundIcon />
          </EmptyMedia>
          <EmptyTitle>No Agent Access yet</EmptyTitle>
          <EmptyDescription>
            Create a scoped credential when an agent needs a machine.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const machineNames = new Map(
    machines.map((machine) => [machine.id, machine.name]),
  );

  return (
    <div className="divide-y">
      {accesses.map((access) => (
        <AccessRow
          key={access.id}
          access={access}
          machineNames={machineNames}
        />
      ))}
    </div>
  );
}

function AccessRow({
  access,
  machineNames,
}: {
  access: AgentAccess;
  machineNames: Map<string, string>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revokeAccess() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/agent-access/${access.id}`, {
        method: "DELETE",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? "Could not revoke Agent Access");
      }
      setOpen(false);
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not revoke Agent Access",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-heading font-medium">{access.name}</p>
          <Badge variant={statusVariant(access.status)}>{access.status}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {access.machineIds
            .map((id) => machineNames.get(id) ?? "Removed machine")
            .join(", ")}
          {" · "}
          expires {formatTimestamp(access.expiresAt)}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {access.capabilities.map((capability) => (
            <Badge key={capability} variant="outline">
              {capability}
            </Badge>
          ))}
        </div>
        {error ? (
          <p className="mt-2 text-sm text-destructive">{error}</p>
        ) : null}
      </div>
      {access.status === "active" ? (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger
            render={
              <Button type="button" variant="outline" size="sm" />
            }
          >
            Revoke
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke {access.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The credential will stop working immediately and its active
                sessions will close. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={revokeAccess}
                disabled={pending}
              >
                {pending ? "Revoking…" : "Revoke access"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

function statusVariant(
  status: AgentAccess["status"],
): "default" | "outline" | "destructive" {
  if (status === "active") return "default";
  if (status === "revoked") return "destructive";
  return "outline";
}

function formatTimestamp(value: string | null): string {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
