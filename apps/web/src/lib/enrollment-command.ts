import { DEFAULT_CLOUD_SERVER_URL } from "@odyshell/protocol";

export function machineEnrollmentCommand(options: {
  serverUrl: string;
  token: string;
  machineName: string;
}): string {
  const args = ["ods"];
  if (options.serverUrl !== DEFAULT_CLOUD_SERVER_URL) {
    args.push("--server", options.serverUrl);
  }
  args.push("up", "--token", options.token, "--name", options.machineName);
  return args.map(posixShellArgument).join(" ");
}

export function posixShellArgument(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
