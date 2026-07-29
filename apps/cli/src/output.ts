import pc from "picocolors";
import type { Machine, Operation, OperationEvent, Session } from "./api.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printMachines(machines: Machine[]): void {
  if (machines.length === 0) {
    console.log(pc.dim("No machines enrolled."));
    return;
  }
  printTable(
    ["NAME", "STATUS", "PLATFORM", "ID", "LAST SEEN"],
    machines.map((machine) => [
      machine.name,
      machine.online ? pc.green("online") : pc.dim("offline"),
      machine.runtime
        ? `${machine.runtime.hostPlatform}/${machine.runtime.architecture}`
        : pc.dim("unknown"),
      machine.id,
      machine.lastSeenAt ? new Date(machine.lastSeenAt).toLocaleString() : "never",
    ]),
  );
}

export function printSessions(sessions: Session[]): void {
  if (sessions.length === 0) {
    console.log(pc.dim("No sessions."));
    return;
  }
  printTable(
    ["STATUS", "MACHINE", "SESSION", "EXPIRES"],
    sessions.map((session) => [
      colorStatus(session.status),
      session.machineName ?? session.machineId,
      session.id,
      new Date(session.expiresAt).toLocaleString(),
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
  if (["ready", "online", "succeeded"].includes(status)) return pc.green(status);
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
