"use client";

import type { Capability, SessionRestrictions } from "@odyshell/protocol";
import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useDashboard } from "@/components/dashboard-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  capabilityGroups,
  fullAccessCapabilities,
  readOnlyCapabilities,
} from "@/lib/agent-access-options";

const durations = [
  { value: "900", label: "15 minutes" },
  { value: "3600", label: "1 hour" },
  { value: "14400", label: "4 hours" },
  { value: "28800", label: "8 hours" },
  { value: "86400", label: "24 hours" },
];

const manualCapabilityGroups = capabilityGroups
  .map((group) => ({
    ...group,
    capabilities: group.capabilities.filter(
      (capability) => capability.value !== "docker.logs",
    ),
  }))
  .filter((group) => group.capabilities.length > 0);

export function CreateSessionSheet() {
  const { state, refresh } = useDashboard();
  const context = state.status === "ready" ? state.context : null;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [agentId, setAgentId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [duration, setDuration] = useState("3600");
  const [capabilities, setCapabilities] = useState<Capability[]>([...readOnlyCapabilities]);
  const [program, setProgram] = useState("");
  const [args, setArgs] = useState("");

  const machine = context?.machines.find((candidate) => candidate.id === machineId);
  const locallyAllowed = useMemo<Capability[]>(
    () => machineCapabilities(machine?.runtime).filter((value) => value !== "docker.logs"),
    [machine?.runtime],
  );
  const agents = context?.agents;
  const machines = context?.machines;
  const agentOptions = useMemo(
    () => (agents ?? []).map((agent) => ({
      value: agent.id,
      label: `${agent.name}${agent.credentialActive ? "" : " · Credential unavailable"}`,
    })),
    [agents],
  );
  const machineOptions = useMemo(
    () => (machines ?? []).map((item) => ({
      value: item.id,
      label: `${item.name}${item.online ? "" : " · Offline"}`,
    })),
    [machines],
  );

  function selectMachine(value: string | null) {
    const nextMachineId = value ?? "";
    const nextMachine = context?.machines.find(
      (candidate) => candidate.id === nextMachineId,
    );
    const nextAllowed: Capability[] = machineCapabilities(
      nextMachine?.runtime,
    ).filter((capability) => capability !== "docker.logs");
    setMachineId(nextMachineId);
    setCapabilities(
      readOnlyCapabilities.filter((capability) =>
        nextAllowed.includes(capability),
      ),
    );
  }

  function toggleCapability(capability: Capability) {
    setCapabilities((current) =>
      current.includes(capability)
        ? current.filter((value) => value !== capability)
        : [...current, capability],
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!context || !machine || capabilities.length === 0) return;
    const restrictions: SessionRestrictions = {};
    if (capabilities.includes("process.exec")) {
      if (!program.trim()) {
        toast.add({ title: "Program required", type: "error" });
        return;
      }
      restrictions.process = {
        programs: [{
          program: program.trim(),
          args: splitArguments(args),
          cwd: { path: ".", includeDescendants: false },
        }],
      };
    }
    setPending(true);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          ...(purpose.trim() ? { purpose } : {}),
          agentId,
          durationSeconds: Number(duration),
          scopes: [{
            machineId: machine.id,
            profile: machineProfile(machine.runtime),
            capabilities,
            restrictions,
          }],
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; status?: string };
      if (!response.ok) throw new Error(body.error ?? "Session could not be created");
      setOpen(false);
      reset();
      toast.add({
        title: body.status === "opening" ? "Session opening" : "Session approved",
        type: "success",
      });
      await refresh();
    } catch (error) {
      toast.add({
        title: "Session not created",
        description: error instanceof Error ? error.message : "Try again.",
        type: "error",
      });
    } finally {
      setPending(false);
    }
  }

  function reset() {
    setTitle("");
    setPurpose("");
    setAgentId("");
    setMachineId("");
    setDuration("3600");
    setCapabilities([...readOnlyCapabilities]);
    setProgram("");
    setArgs("");
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button type="button" />}>
        <PlusIcon data-icon="inline-start" />
        New
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>New session</SheetTitle>
          <SheetDescription>Grant one Agent temporary access to one machine.</SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
            <FieldGroup>
              <Field><FieldLabel htmlFor="session-title">Title</FieldLabel><Input id="session-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={96} required /></Field>
              <Field><FieldLabel htmlFor="session-purpose">Purpose</FieldLabel><Textarea id="session-purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={280} /></Field>
              <Field><FieldLabel htmlFor="session-agent">Agent</FieldLabel>
                <Select items={agentOptions} value={agentId} onValueChange={(value) => setAgentId(value ?? "")} required>
                  <SelectTrigger id="session-agent" className="w-full"><SelectValue placeholder="Select Agent" /></SelectTrigger>
                  <SelectContent><SelectGroup>{context?.agents.map((agent) => <SelectItem key={agent.id} value={agent.id} disabled={!agent.credentialActive}>{agent.name}{agent.credentialActive ? "" : " · Credential unavailable"}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field><FieldLabel htmlFor="session-machine">Machine</FieldLabel>
                <Select items={machineOptions} value={machineId} onValueChange={selectMachine} required>
                  <SelectTrigger id="session-machine" className="w-full"><SelectValue placeholder="Select machine" /></SelectTrigger>
                  <SelectContent><SelectGroup>{context?.machines.map((item) => <SelectItem key={item.id} value={item.id} disabled={!item.online}>{item.name}{item.online ? "" : " · Offline"}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field><FieldLabel htmlFor="session-duration">Duration</FieldLabel>
                <Select items={durations} value={duration} onValueChange={(value) => setDuration(value ?? "3600")}>
                  <SelectTrigger id="session-duration" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{durations.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field>
                <div className="flex items-center justify-between gap-3"><FieldLabel>Capabilities</FieldLabel><div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setCapabilities([...readOnlyCapabilities].filter((value) => locallyAllowed.includes(value)))}>Read only</Button><Button type="button" size="sm" variant="outline" onClick={() => setCapabilities([...fullAccessCapabilities].filter((value) => locallyAllowed.includes(value)))}>Full access</Button></div></div>
                <div className="rounded-lg border p-3">
                  {manualCapabilityGroups.flatMap((group) => group.capabilities).map((capability) => (
                    <label key={capability.value} className="flex items-center gap-2 py-1.5 text-sm">
                      <Checkbox checked={capabilities.includes(capability.value)} disabled={!locallyAllowed.includes(capability.value)} onCheckedChange={() => toggleCapability(capability.value)} />
                      {capability.label}
                    </label>
                  ))}
                </div>
              </Field>
              {capabilities.includes("process.exec") ? <><Field><FieldLabel htmlFor="session-program">Program</FieldLabel><Input id="session-program" value={program} onChange={(event) => setProgram(event.target.value)} required /></Field><Field><FieldLabel htmlFor="session-args">Arguments</FieldLabel><Input id="session-args" value={args} onChange={(event) => setArgs(event.target.value)} /></Field></> : null}
              {capabilities.includes("process.shell") ? <p className="text-sm text-amber-700 dark:text-amber-400">Shell access can run arbitrary commands as the local OS user and always requires explicit approval.</p> : null}
            </FieldGroup>
          </div>
          <SheetFooter className="border-t">
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={pending || !title.trim() || !agentId || !machineId || capabilities.length === 0}>{pending ? <Spinner /> : null}Create</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function machineCapabilities(runtime: unknown): Capability[] {
  if (!runtime || typeof runtime !== "object") return [];
  const profiles = Array.isArray((runtime as { profiles?: unknown }).profiles)
    ? (runtime as { profiles: Array<{ name?: string; capabilities?: unknown }> }).profiles
    : [];
  const profile = profiles.find((candidate) => candidate.name === "default") ?? profiles[0];
  const values = Array.isArray(profile?.capabilities) ? profile.capabilities : [];
  return [...new Set(values.filter((value): value is Capability => typeof value === "string"))];
}

function machineProfile(runtime: unknown): string {
  if (!runtime || typeof runtime !== "object") return "default";
  const profiles = (runtime as { profiles?: Array<{ name?: string }> }).profiles;
  return profiles?.find((profile) => profile.name === "default")?.name ?? profiles?.[0]?.name ?? "default";
}

function splitArguments(value: string): string[] {
  return value.trim() ? value.trim().split(/\s+/u) : [];
}
