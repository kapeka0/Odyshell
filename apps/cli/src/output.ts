import pc from "picocolors";
import type { ListedClientProfile } from "@odyshell/client";
import type {
  ListedAgent,
  ListedAgentSession,
  AuditEvent,
  Machine,
  Operation,
  OperationEvent,
} from "@odyshell/sdk";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printMachines(
  machines: Array<Machine & { revokedAt?: string | null }>,
): void {
  if (machines.length === 0) {
    console.log(pc.dim("No machines enrolled."));
    return;
  }
  printTable(
    ["NAME", "STATUS", "VERSION", "PLATFORM", "RUNNER", "ID", "LAST SEEN"],
    machines.map((machine) => [
      machine.name,
      machine.revokedAt
        ? pc.red("revoked")
        : machine.online
          ? pc.green("online")
          : pc.dim("offline"),
      machine.upgradeRequired
        ? pc.red(`${machine.clientVersion ?? "unknown"} (update)`)
        : (machine.clientVersion ?? pc.dim("unknown")),
      machine.runtime
        ? `${machine.runtime.hostPlatform}/${machine.runtime.architecture}`
        : pc.dim("unknown"),
      machine.runtime?.executionRunners?.join(",") ??
        (machine.runtime?.containerEngine ? "docker" : pc.dim("unknown")),
      machine.id,
      machine.lastSeenAt ? new Date(machine.lastSeenAt).toLocaleString() : "never",
    ]),
  );
}

export function printClientProfiles(profiles: ListedClientProfile[]): void {
  if (profiles.length === 0) {
    console.log(pc.dim("No Client Profiles."));
    return;
  }
  printTable(
    ["PROFILE", "STATUS", "SUDO", "MACHINE", "SERVER"],
    profiles.map((profile) => [
      profile.profileName,
      clientProfileStatus(profile),
      profile.allowPrivilegeEscalation ? pc.yellow("allowed") : pc.dim("blocked"),
      profile.machineName ?? pc.dim("unknown"),
      profile.serverUrl ?? pc.dim("unknown"),
    ]),
  );
}

function clientProfileStatus(profile: ListedClientProfile): string {
  if (!profile.valid) return pc.red("invalid");
  if (profile.service.current === false) return pc.yellow("restart");
  if (profile.service.active) return pc.green("running");
  if (profile.service.installed) return pc.dim("stopped");
  return pc.dim("not installed");
}

export function printSessions(sessions: ListedAgentSession[]): void {
  if (sessions.length === 0) {
    console.log(pc.dim("No sessions."));
    return;
  }
  printTable(
    ["STATUS", "AGENT", "MACHINES", "PURPOSE", "SESSION", "EXPIRES"],
    sessions.map((session) => [
      colorStatus(session.status),
      session.agentName,
      session.targets.map((target) => target.machineName).join(", ") || "none",
      session.purpose ?? session.title,
      session.id,
      new Date(session.expiresAt).toLocaleString(),
    ]),
  );
}

export function printAgents(agents: ListedAgent[]): void {
  if (agents.length === 0) {
    console.log(pc.dim("No Agents."));
    return;
  }
  printTable(
    ["NAME", "STATUS", "TYPE", "PARENT", "ID"],
    agents.map((agent) => [
      agent.name,
      colorStatus(agent.status),
      agent.kind,
      agent.parentAgentId ?? "—",
      agent.id,
    ]),
  );
}

export function printAudit(
  principal: { id: string; name: string },
  events: AuditEvent[],
): void {
  console.log(pc.dim(`Agent ${principal.name} (${principal.id})`));
  if (events.length === 0) {
    console.log(pc.dim("No audit events."));
    return;
  }
  printTable(
    ["TIME", "AGENT", "ACTION", "TARGET", "DETAILS"],
    events.map((event) => [
      new Date(event.createdAt).toLocaleString(),
      event.principalId,
      event.action,
      `${event.targetType}:${event.targetId}`,
      Object.keys(event.metadata).length > 0 ? JSON.stringify(event.metadata) : "",
    ]),
  );
}

export function streamEvent(event: OperationEvent): void {
  const data = Buffer.from(event.dataBase64, "base64");
  if (event.stream === "stderr") process.stderr.write(data);
  else process.stdout.write(data);
}

export function operationJson(operation: Operation): Record<string, unknown> {
  const decoded = { stdout: "", stderr: "", result: "" };
  for (const event of operation.events) {
    decoded[event.stream] += Buffer.from(event.dataBase64, "base64").toString("utf8");
  }
  return { ...operation, output: decoded };
}

export function colorStatus(status: string): string {
  if (["active", "ready", "online", "succeeded"].includes(status)) return pc.green(status);
  if (["failed", "timed_out", "execution_unknown"].includes(status)) return pc.red(status);
  if (["opening", "queued", "delivered", "running", "closing"].includes(status)) {
    return pc.yellow(status);
  }
  return pc.dim(status);
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) =>
    Math.max(
      visibleLength(header),
      ...rows.map((row) => visibleLength(row[index] ?? "")),
    ),
  );
  console.log(
    headers
      .map((header, index) => pc.bold(header.padEnd(widths[index] ?? header.length)))
      .join("  "),
  );
  for (const row of rows) {
    console.log(
      row
        .map((cell, index) => `${cell}${" ".repeat(Math.max(0, (widths[index] ?? 0) - visibleLength(cell)))}`)
        .join("  "),
    );
  }
}

function visibleLength(value: string): number {
  return value.replace(/\u001B\[[0-9;]*m/g, "").length;
}
