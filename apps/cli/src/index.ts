import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { Command } from "commander";
import pc from "picocolors";
import {
  allCapabilities,
  capabilitySchema,
  type Capability,
  type OperationAction,
} from "@odyshell/protocol";
import {
  defaultClientConfigPath,
  enrollClient,
  inspectClientRuntime,
  runClient,
} from "@odyshell/client";
import { ApiError, OdyshellApi, type Operation } from "./api.js";
import {
  defaultConfigPath,
  loadStoredConfig,
  removeStoredConfig,
  resolveConfig,
  saveStoredConfig,
  type GlobalOptions,
} from "./config.js";
import {
  colorStatus,
  operationJson,
  printAudit,
  printJson,
  printMachines,
  printSessions,
  streamEvent,
} from "./output.js";

const program = new Command();
program
  .name("ods")
  .description("Agent-first access to private machines")
  .version("0.6.0")
  .option("-j, --json", "emit stable JSON output")
  .option("--server <url>", "override the Odyshell server URL")
  .option("--agent-token <token>", "override the scoped agent token")
  .option("--agent-key <key>", "use the legacy development agent key")
  .option("--admin-key <key>", "override the administrator API key")
  .option("--config-file <path>", "use a different configuration file")
  .showSuggestionAfterError()
  .showHelpAfterError();
program.enablePositionalOptions();

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function normalizeGlobalOptions(argv: string[]): string[] {
  const flagsWithValues = [
    "--server",
    "--agent-token",
    "--agent-key",
    "--admin-key",
    "--config-file",
  ];
  const globalArguments: string[] = [];
  const commandArguments: string[] = [];

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") {
      commandArguments.push(...argv.slice(index));
      break;
    }
    if (argument === "--json" || argument === "-j") {
      globalArguments.push(argument);
      continue;
    }

    const flag = flagsWithValues.find(
      (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
    );
    if (!flag) {
      commandArguments.push(argument);
      continue;
    }

    globalArguments.push(argument);
    if (argument === flag && argv[index + 1] !== undefined) {
      globalArguments.push(argv[index + 1]!);
      index += 1;
    }
  }

  return [...argv.slice(0, 2), ...globalArguments, ...commandArguments];
}

async function apiFor(command: Command): Promise<OdyshellApi> {
  return new OdyshellApi(await resolveConfig(globals(command)));
}

function parseCapabilities(value: string): Capability[] {
  const parsed = capabilitySchema
    .array()
    .min(1)
    .safeParse(
      [...new Set(value.split(",").map((capability) => capability.trim()))].filter(Boolean),
    );
  if (!parsed.success) {
    throw new Error(`Invalid capabilities. Choose from: ${allCapabilities.join(", ")}`);
  }
  return parsed.data;
}

async function finishOperation(
  api: OdyshellApi,
  operationId: string,
  json: boolean,
): Promise<Operation> {
  const operation = await api.waitForOperation(operationId, json ? undefined : streamEvent);
  if (json) printJson(operationJson(operation));
  else if (operation.error) console.error(pc.red(`\n${operation.error}`));
  if (operation.status !== "succeeded") process.exitCode = 1;
  return operation;
}

async function runInTemporarySession(
  command: Command,
  machineReference: string,
  capability: Capability,
  action: OperationAction,
  ttlSeconds: number,
  timeoutSeconds: number,
): Promise<void> {
  const options = globals(command);
  const api = await apiFor(command);
  const machine = await api.resolveMachine(machineReference);
  const created = await api.createSession(machine.id, [capability], ttlSeconds);
  const session = await api.waitForSession(created.id);
  try {
    const operation = await api.createOperation(session.id, action, timeoutSeconds);
    await finishOperation(api, operation.id, options.json ?? false);
  } finally {
    await api.closeSession(session.id).catch(() => {});
  }
}

program
  .command("login")
  .description("save server credentials and verify the connection")
  .action(async (_options, command: Command) => {
    const options = globals(command);
    const configPath = options.configFile ? resolve(options.configFile) : defaultConfigPath();
    const previous = await loadStoredConfig(configPath);
    const resolved = await resolveConfig(options);
    if (!resolved.agentToken) {
      throw new Error(
        "An agent token is required. Pass --agent-token or set ODYSHELL_AGENT_TOKEN.",
      );
    }
    const api = new OdyshellApi(resolved);
    await api.health();
    await api.machines();
    const savedAdminKey = resolved.adminKey ?? previous?.adminKey;
    await saveStoredConfig(
      {
        serverUrl: resolved.serverUrl,
        agentToken: resolved.agentToken,
        ...(savedAdminKey ? { adminKey: savedAdminKey } : {}),
      },
      configPath,
    );
    if (options.json) printJson({ authenticated: true, serverUrl: resolved.serverUrl, configPath });
    else {
      console.log(`${pc.green("✓")} Connected to ${pc.bold(resolved.serverUrl)}`);
      console.log(pc.dim(`  Credentials saved to ${configPath}`));
    }
  });

program
  .command("logout")
  .description("remove locally stored credentials")
  .action(async (_options, command: Command) => {
    const options = globals(command);
    const configPath = options.configFile ? resolve(options.configFile) : defaultConfigPath();
    await removeStoredConfig(configPath);
    if (options.json) printJson({ loggedOut: true, configPath });
    else console.log(`${pc.green("✓")} Removed ${configPath}`);
  });

program
  .command("status")
  .description("check the server and connected machines")
  .action(async (_options, command: Command) => {
    const options = globals(command);
    const api = await apiFor(command);
    const [health, machines] = await Promise.all([api.health(), api.machines()]);
    if (options.json) printJson({ serverUrl: api.serverUrl, health, machines });
    else {
      console.log(`${pc.green("●")} ${pc.bold(api.serverUrl)}  protocol v${health.protocol}`);
      printMachines(machines);
    }
  });

program
  .command("machines")
  .alias("machine")
  .description("list enrolled machines")
  .action(async (_options, command: Command) => {
    const options = globals(command);
    const machines = await (await apiFor(command)).machines();
    if (options.json) printJson({ data: machines });
    else printMachines(machines);
  });

program
  .command("sessions")
  .description("list recent sessions")
  .action(async (_options, command: Command) => {
    const options = globals(command);
    const sessions = await (await apiFor(command)).sessions();
    if (options.json) printJson({ data: sessions });
    else printSessions(sessions);
  });

const token = program.command("token").description("manage enrollment tokens");
token
  .command("create")
  .description("create a one-time client enrollment token")
  .option("--ttl <seconds>", "token lifetime", "600")
  .action(async (options: { ttl: string }, command: Command) => {
    const global = globals(command);
    const result = await (await apiFor(command)).createEnrollmentToken(Number(options.ttl));
    if (global.json) printJson(result);
    else {
      console.log(result.token);
      console.error(pc.dim(`Expires ${new Date(result.expiresAt).toLocaleString()}`));
    }
  });

const agent = program.command("agent").description("manage scoped agent access");
agent
  .command("create <name>")
  .description("create a scoped agent token")
  .requiredOption("--machines <ids>", "comma-separated machine IDs")
  .requiredOption("--allow <capabilities>", "comma-separated capabilities")
  .option("--ttl <seconds>", "token lifetime", "86400")
  .action(
    async (
      name: string,
      options: { machines: string; allow: string; ttl: string },
      command: Command,
    ) => {
      const global = globals(command);
      const machineIds = [...new Set(options.machines.split(",").map((id) => id.trim()))].filter(
        Boolean,
      );
      if (machineIds.length === 0) throw new Error("At least one machine ID is required");
      const result = await (await apiFor(command)).createAgentToken(
        name,
        machineIds,
        parseCapabilities(options.allow),
        Number(options.ttl),
      );
      if (global.json) printJson(result);
      else {
        console.log(result.token);
        console.error(pc.dim(`Agent ${result.name} (${result.id})`));
        console.error(pc.dim(`Expires ${new Date(result.expiresAt).toLocaleString()}`));
      }
    },
  );

program
  .command("audit")
  .description("show recent actions for the current agent")
  .option("--limit <count>", "number of events", "50")
  .action(async (options: { limit: string }, command: Command) => {
    const global = globals(command);
    const result = await (await apiFor(command)).audit(Number(options.limit));
    if (global.json) printJson(result);
    else printAudit(result.principal, result.data);
  });

const session = program.command("session").description("manage persistent sessions");
session
  .command("create <machine>")
  .description("open a temporary session")
  .option("--ttl <seconds>", "session lifetime", "600")
  .requiredOption("--capabilities <items>", "comma-separated capabilities")
  .action(async (machineReference: string, options: { ttl: string; capabilities: string }, command: Command) => {
    const global = globals(command);
    const api = await apiFor(command);
    const machine = await api.resolveMachine(machineReference);
    const capabilities = parseCapabilities(options.capabilities);
    const created = await api.createSession(machine.id, capabilities, Number(options.ttl));
    const ready = await api.waitForSession(created.id);
    if (global.json) printJson(ready);
    else {
      console.log(`${pc.green("✓")} Session ${pc.bold(ready.id)} is ready`);
      console.log(pc.dim(`  expires ${new Date(ready.expiresAt).toLocaleString()}`));
    }
  });

session
  .command("inspect <session-id>")
  .description("show a session")
  .action(async (sessionId: string, _options, command: Command) => {
    const global = globals(command);
    const result = await (await apiFor(command)).session(sessionId);
    if (global.json) printJson(result);
    else {
      console.log(`${colorStatus(result.status)}  ${result.id}`);
      console.log(`machine       ${result.machineName ?? result.machineId}`);
      console.log(`profile       ${result.profile}`);
      console.log(`capabilities  ${result.capabilities.join(", ")}`);
      console.log(`expires       ${new Date(result.expiresAt).toLocaleString()}`);
    }
  });

session
  .command("close <session-id>")
  .description("close a session")
  .action(async (sessionId: string, _options, command: Command) => {
    const global = globals(command);
    const result = await (await apiFor(command)).closeSession(sessionId);
    if (global.json) printJson(result);
    else console.log(`${pc.green("✓")} Closing ${sessionId}`);
  });

session
  .command("exec <session-id> <program> [args...]")
  .description("execute a program in an existing session")
  .option("--timeout <seconds>", "operation timeout", "120")
  .passThroughOptions()
  .action(
    async (
      sessionId: string,
      executable: string,
      args: string[],
      options: { timeout: string },
      command: Command,
    ) => {
      const global = globals(command);
      const api = await apiFor(command);
      const operation = await api.createOperation(
        sessionId,
        { kind: "process.exec", program: executable, args, cwd: ".", env: {} },
        Number(options.timeout),
      );
      await finishOperation(api, operation.id, global.json ?? false);
    },
  );

program
  .command("exec <machine> <program> [args...]")
  .description("run a program in a disposable session")
  .option("--ttl <seconds>", "session lifetime", "300")
  .option("--timeout <seconds>", "operation timeout", "120")
  .passThroughOptions()
  .action(
    async (
      machine: string,
      executable: string,
      args: string[],
      options: { ttl: string; timeout: string },
      command: Command,
    ) =>
      runInTemporarySession(
        command,
        machine,
        "process.exec",
        { kind: "process.exec", program: executable, args, cwd: ".", env: {} },
        Number(options.ttl),
        Number(options.timeout),
      ),
  );

program
  .command("shell <machine> <command...>")
  .description("run a shell command in a disposable session")
  .option("--ttl <seconds>", "session lifetime", "300")
  .option("--timeout <seconds>", "operation timeout", "120")
  .passThroughOptions()
  .action(
    async (
      machine: string,
      commandParts: string[],
      options: { ttl: string; timeout: string },
      command: Command,
    ) =>
      runInTemporarySession(
        command,
        machine,
        "process.shell",
        { kind: "process.shell", command: commandParts.join(" "), cwd: ".", env: {} },
        Number(options.ttl),
        Number(options.timeout),
      ),
  );

const fsCommand = program.command("fs").description("access a machine workspace");
fsCommand
  .command("read <machine> <path>")
  .description("read a file through a disposable session")
  .action(async (machine: string, path: string, _options, command: Command) =>
    runInTemporarySession(
      command,
      machine,
      "fs.read",
      { kind: "fs.read", path },
      300,
      120,
    ),
  );

fsCommand
  .command("list <machine> [path]")
  .description("list a directory through a disposable session")
  .action(async (machine: string, path: string | undefined, _options, command: Command) =>
    runInTemporarySession(
      command,
      machine,
      "fs.list",
      { kind: "fs.list", path: path ?? "." },
      300,
      120,
    ),
  );

fsCommand
  .command("write <machine> <path>")
  .description("write a file through a disposable session")
  .option("--content <text>", "text to write")
  .option("--file <path>", "read content from a local file")
  .action(
    async (
      machine: string,
      path: string,
      options: { content?: string; file?: string },
      command: Command,
    ) => {
      if (options.content === undefined && !options.file) {
        throw new Error("Pass --content <text> or --file <path>");
      }
      if (options.content !== undefined && options.file) {
        throw new Error("--content and --file are mutually exclusive");
      }
      const content =
        options.content !== undefined ? Buffer.from(options.content) : await readFile(resolve(options.file!));
      await runInTemporarySession(
        command,
        machine,
        "fs.write",
        {
          kind: "fs.write",
          path,
          contentBase64: content.toString("base64"),
          createParents: true,
        },
        300,
        120,
      );
    },
  );

const client = program.command("client").description("manage the private-machine client");
client
  .command("doctor")
  .description("check this host for client compatibility")
  .option("--config <path>", "client configuration", defaultClientConfigPath())
  .action(async (options: { config: string }, command: Command) => {
    const global = globals(command);
    const configPath = resolve(options.config);
    const configFound = await access(configPath).then(
      () => true,
      () => false,
    );
    const runtime = await inspectClientRuntime();
    const report = { compatible: true, configPath, configFound, runtime };
    if (global.json) printJson(report);
    else {
      console.log(`${pc.green("✓")} ${runtime.hostPlatform}/${runtime.architecture}`);
      console.log(`  Node    ${runtime.nodeVersion}`);
      console.log(
        `  Docker  ${runtime.containerEngineVersion} (${runtime.containerOs}/${runtime.containerArchitecture})`,
      );
      console.log(`  Config  ${configFound ? configPath : `${configPath} (not enrolled)`}`);
    }
  });

client
  .command("enroll")
  .description("enroll this machine with an Odyshell server")
  .requiredOption("--token <token>", "one-time enrollment token")
  .requiredOption("--name <name>", "machine name")
  .requiredOption("--workspace <path>", "workspace exposed to sessions")
  .requiredOption("--allow <capabilities>", "comma-separated capabilities allowed by this machine")
  .option("--image <image>", "sandbox image", "alpine:3.22")
  .option("--config <path>", "client configuration", defaultClientConfigPath())
  .action(
    async (
      options: {
        token: string;
        name: string;
        workspace: string;
        allow: string;
        image: string;
        config: string;
      },
      command: Command,
    ) => {
      const global = globals(command);
      const config = await resolveConfig(global);
      const result = await enrollClient({
        serverUrl: config.serverUrl,
        token: options.token,
        machineName: options.name,
        workspaceRoot: options.workspace,
        allowedCapabilities: parseCapabilities(options.allow),
        image: options.image,
        configPath: options.config,
      });
      if (global.json) printJson({ enrolled: true, ...result });
      else {
        console.log(`${pc.green("✓")} Enrolled ${options.name}`);
        console.log(`  machine  ${result.machineId}`);
        console.log(`  config   ${result.configPath}`);
      }
    },
  );

client
  .command("start")
  .description("start the outbound client in the foreground")
  .option("--config <path>", "client configuration", defaultClientConfigPath())
  .action(async (options: { config: string }) => {
    await runClient(options.config);
  });

await program.parseAsync(normalizeGlobalOptions(process.argv)).catch((error: unknown) => {
  if (error instanceof ApiError) {
    console.error(pc.red(`Error: ${error.code} (${error.status})`));
    if (error.details) console.error(JSON.stringify(error.details, null, 2));
  } else {
    console.error(pc.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
  }
  process.exitCode = 1;
});
