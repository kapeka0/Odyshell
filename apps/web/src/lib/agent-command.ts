import { DEFAULT_CLOUD_SERVER_URL } from "@odyshell/protocol";
import { posixShellArgument } from "./enrollment-command";

export function agentLoginCommand(options: {
  serverUrl: string;
  token: string;
}): string {
  const args = ["ods"];
  if (options.serverUrl !== DEFAULT_CLOUD_SERVER_URL) {
    args.push("--server", options.serverUrl);
  }
  args.push("login", "--agent-token", options.token);
  return args.map(posixShellArgument).join(" ");
}
