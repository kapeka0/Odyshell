import type { Capability } from "@odyshell/protocol";

export const agentAccessDurations = [
  { label: "1 hour", value: 60 * 60 },
  { label: "7 days", value: 7 * 24 * 60 * 60 },
  { label: "1 month", value: 30 * 24 * 60 * 60 },
  { label: "6 months", value: 180 * 24 * 60 * 60 },
  { label: "1 year", value: 365 * 24 * 60 * 60 },
] as const;

export const readOnlyCapabilities: Capability[] = [
  "fs.stat",
  "fs.list",
  "fs.search",
  "fs.read",
  "docker.logs",
];

export function isReadOnlyPreset(capabilities: Capability[]): boolean {
  return (
    capabilities.length === readOnlyCapabilities.length &&
    readOnlyCapabilities.every((capability) =>
      capabilities.includes(capability),
    )
  );
}

export function toggleReadOnlyPreset(
  capabilities: Capability[],
): Capability[] {
  return isReadOnlyPreset(capabilities) ? [] : [...readOnlyCapabilities];
}

export const capabilityGroups: Array<{
  name: string;
  capabilities: Array<{
    value: Capability;
    label: string;
    description: string;
  }>;
}> = [
  {
    name: "Execution",
    capabilities: [
      {
        value: "process.exec",
        label: "Run programs",
        description: "Execute a program with structured arguments.",
      },
      {
        value: "host.shell",
        label: "Host Shell",
        description: "Run native shell commands with the Client user's authority.",
      },
    ],
  },
  {
    name: "Filesystem",
    capabilities: [
      {
        value: "fs.stat",
        label: "Inspect files",
        description: "Read file and directory metadata.",
      },
      {
        value: "fs.list",
        label: "List directories",
        description: "List entries on the machine.",
      },
      {
        value: "fs.search",
        label: "Search files",
        description: "Search names on the machine.",
      },
      {
        value: "fs.read",
        label: "Read files",
        description: "Read file contents.",
      },
      {
        value: "fs.write",
        label: "Write files",
        description: "Create or replace file contents.",
      },
      {
        value: "fs.mkdir",
        label: "Create directories",
        description: "Create directories on the machine.",
      },
      {
        value: "fs.remove",
        label: "Remove files",
        description: "Delete files or directories.",
      },
    ],
  },
  {
    name: "Docker",
    capabilities: [
      {
        value: "docker.logs",
        label: "Read container logs",
        description: "Read bounded logs from a named container.",
      },
    ],
  },
];
