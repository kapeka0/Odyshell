import pc from "picocolors";
import type { ListedClientProfile } from "@odyshell/client";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printClientProfiles(profiles: ListedClientProfile[]): void {
  if (profiles.length === 0) {
    console.log(pc.dim("No Client Profiles."));
    return;
  }
  printTable(
    ["PROFILE", "STATUS", "MACHINE", "SERVER"],
    profiles.map((profile) => [
      profile.profileName,
      clientProfileStatus(profile),
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
        .map((cell, index) =>
          `${cell}${" ".repeat(Math.max(0, (widths[index] ?? 0) - visibleLength(cell)))}`)
        .join("  "),
    );
  }
}

function visibleLength(value: string): number {
  return value.replace(/\u001B\[[0-9;]*m/g, "").length;
}
