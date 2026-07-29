import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { Command } from "commander";
import pc from "picocolors";
import {
  allCapabilities,
  type Capability,
  type OperationAction,
} from "@odyshell/protocol";
import {
  defaultConnectorConfigPath,
  enrollConnector,
  inspectConnectorRuntime,
  runConnector,
} from "@odyshell/connector";
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
  printJson,
  printMachines,
  printSessions,
  streamEvent,
} from "./output.js";

const program = new Command();
program
  .name("ods")
  .description("Agent-first access to private machines")
  .version("0.3.0")
  .option("-j, --json", "emit stable JSON output")
  .option("--server <url>", "override the Odyshell server URL")
  .option("--agent-key <key>", "override the agent API key")
  .option("--admin-key <key>", "override the administrator API key")
  .option("--config-file <path>", "use a different configuration file")
  .showSuggestionAfterError()
  .showHelpAfterError();
program.enablePositionalOptions();

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function normalizeGlobalOptions(argv: string[]): string[] {
  const flagsWithValues = ["--server", "--agent-key", "--admin-key", "--config-file"];
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
    if (!resolved.agentKey) {
      throw new Error("An agent key is required. Pass --agent-key or set ODYSHELL_AGENT_KEY.");
    }
    const api = new OdyshellApi(resolved);
    await api.health();
    await api.machines();
    const savedAdminKey = resolved.adminKey ?? previous?.adminKey;
    await saveStoredConfig(
      {
        serverUrl: resolved.serverUrl,
        agentKey: resolved.agentKey,
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
  .description("check the control plane and connected machines")
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
  .description("create a one-time connector enrollment token")
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

const session = program.command("session").description("manage persistent sessions");
session
  .command("create <machine>")
  .description("open a temporary session")
  .option("--ttl <seconds>", "session lifetime", "600")
  .option(
    "--capabilities <items>",
    "comma-separated capabilities",
    allCapabilities.join(","),
  )
  .action(async (machineReference: string, options: { ttl: string; capabilities: string }, command: Command) => {
    const global = globals(command);
    const api = await apiFor(command);
    const machine = await api.resolveMachine(machineReference);
    const capabilities = options.capabilities.split(",") as Capability[];
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

const connector = program.command("connector").description("manage the private-machine connector");
connector
  .command("doctor")
  .description("check this host for connector compatibility")
  .option("--config <path>", "connector configuration", defaultConnectorConfigPath())
  .action(async (options: { config: string }, command: Command) => {
    const global = globals(command);
    const configPath = resolve(options.config);
    const configFound = await access(configPath).then(
      () => true,
      () => false,
    );
    const runtime = await inspectConnectorRuntime();
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

connector
  .command("enroll")
  .description("enroll this machine with an Odyshell control plane")
  .requiredOption("--token <token>", "one-time enrollment token")
  .requiredOption("--name <name>", "machine name")
  .requiredOption("--workspace <path>", "workspace exposed to sessions")
  .option("--image <image>", "sandbox image", "alpine:3.22")
  .option("--config <path>", "connector configuration", defaultConnectorConfigPath())
  .action(
    async (
      options: { token: string; name: string; workspace: string; image: string; config: string },
      command: Command,
    ) => {
      const global = globals(command);
      const config = await resolveConfig(global);
      const result = await enrollConnector({
        serverUrl: config.serverUrl,
        token: options.token,
        machineName: options.name,
        workspaceRoot: options.workspace,
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

connector
  .command("start")
  .description("start the outbound connector in the foreground")
  .option("--config <path>", "connector configuration", defaultConnectorConfigPath())
  .action(async (options: { config: string }) => {
    await runConnector(options.config);
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
