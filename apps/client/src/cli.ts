import process from "node:process";
import { capabilitySchema, type Capability } from "@odyshell/protocol";
import {
  defaultClientConfigPath,
  enrollClient,
  inspectClientRuntime,
  runClient,
} from "./index.js";

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function requiredOption(name: string, fallback?: string): string {
  const value = option(name, fallback);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function requiredCapabilities(name: string, fallback?: string): Capability[] {
  const value = requiredOption(name, fallback);
  const parsed = capabilitySchema
    .array()
    .min(1)
    .safeParse([...new Set(value.split(",").map((item) => item.trim()))].filter(Boolean));
  if (!parsed.success) throw new Error(`Invalid --${name} capability list`);
  return parsed.data;
}

const command = process.argv[2];
if (command === "enroll") {
  const runner = option("runner", "host");
  if (runner !== "host" && runner !== "docker") {
    throw new Error("--runner must be host or docker");
  }
  const result = await enrollClient({
    serverUrl: requiredOption("server", process.env.ODYSHELL_SERVER_URL),
    token: requiredOption("token", process.env.ODYSHELL_ENROLLMENT_TOKEN),
    machineName: requiredOption("name", process.env.ODYSHELL_MACHINE_NAME),
    workspaceRoot: requiredOption("workspace", process.cwd()),
    allowedCapabilities: requiredCapabilities("allow", process.env.ODYSHELL_ALLOWED_CAPABILITIES),
    configPath: option("config", defaultClientConfigPath())!,
    runner,
    image: option("image", "alpine:3.22") ?? "alpine:3.22",
  });
  console.log(JSON.stringify({ enrolled: true, ...result }, null, 2));
} else if (command === "start") {
  await runClient(option("config", defaultClientConfigPath())!);
} else if (command === "doctor") {
  const runner = option("runner", "host");
  if (runner !== "host" && runner !== "docker") {
    throw new Error("--runner must be host or docker");
  }
  console.log(JSON.stringify(await inspectClientRuntime([runner]), null, 2));
} else {
  console.error("Usage: ods-client <doctor|enroll|start> [options]");
  process.exitCode = 1;
}
