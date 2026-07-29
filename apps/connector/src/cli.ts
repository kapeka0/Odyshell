import process from "node:process";
import {
  defaultConnectorConfigPath,
  enrollConnector,
  inspectConnectorRuntime,
  runConnector,
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

const command = process.argv[2];
if (command === "enroll") {
  const result = await enrollConnector({
    serverUrl: requiredOption("server", process.env.ODYSHELL_SERVER_URL),
    token: requiredOption("token", process.env.ODYSHELL_ENROLLMENT_TOKEN),
    machineName: requiredOption("name", process.env.ODYSHELL_MACHINE_NAME),
    workspaceRoot: requiredOption("workspace", process.cwd()),
    configPath: option("config", defaultConnectorConfigPath())!,
    image: option("image", "alpine:3.22") ?? "alpine:3.22",
  });
  console.log(JSON.stringify({ enrolled: true, ...result }, null, 2));
} else if (command === "start") {
  await runConnector(option("config", defaultConnectorConfigPath())!);
} else if (command === "doctor") {
  console.log(JSON.stringify(await inspectConnectorRuntime(), null, 2));
} else {
  console.error("Usage: ods-connector <doctor|enroll|start> [options]");
  process.exitCode = 1;
}
