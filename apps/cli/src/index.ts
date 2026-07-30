import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import open from "open";
import pc from "picocolors";
import {
  allCapabilities,
  capabilitySchema,
  type Capability,
  type OperationAction,
} from "@odyshell/protocol";
import {
  defaultClientConfigPath,
  clientServiceStatus,
  enrollClient,
  inspectClientRuntime,
  installLinuxUserService,
  runClient,
  stopLinuxUserService,
} from "@odyshell/client";
import { ApiError, Odyshell, OdyshellApi, type Operation } from "@odyshell/sdk";
import { parseDuration } from "./duration.js";
import { ExpectedError, printCliError } from "./errors.js";
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
  printAgents,
  printAudit,
  printJson,
  printMachines,
  printSessions,
  streamEvent,
} from "./output.js";
import { assertClientUpConfiguration } from "./up.js";
import { serveOdyshellMcp } from "./mcp.js";

const program = new Command();
program
  .name("ods")
  .description("Agent-first access to private machines")
  .version("0.8.0")
  .option("-j, --json", "emit stable JSON output")
  .option("--server <url>", "override the Odyshell server URL")
  .option("--workspace-id <id>", "select the administrator workspace")
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
    "--workspace-id",
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
    throw new ExpectedError(
      `Invalid capabilities. Choose from: ${allCapabilities.join(", ")}`,
      "invalid_capabilities",
    );
  }
  return parsed.data;
}

function parseRunner(value: string): "host" | "docker" {
  if (value === "host" || value === "docker") return value;
  throw new ExpectedError("--runner must be host or docker", "invalid_runner");
}

function requiredValue(value: string | undefined, flag: string): string {
  if (value) return value;
  throw new ExpectedError(
    `${flag} is required when enrolling a new machine`,
    "enrollment_option_required",
  );
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
  .description("sign in through the Odyshell web app")
  .option("--no-browser", "do not open the verification page automatically")
  .action(async (loginOptions: { browser: boolean }, command: Command) => {
    const options = globals(command);
    const configPath = options.configFile ? resolve(options.configFile) : defaultConfigPath();
    const previous = await loadStoredConfig(configPath);
    const resolved = await resolveConfig(options);
    const api = new OdyshellApi(resolved);
    await api.health();

    const explicitAgentToken =
      options.agentToken ??
      options.agentKey ??
      process.env.ODYSHELL_AGENT_TOKEN ??
      process.env.ODYSHELL_AGENT_KEY;
    if (explicitAgentToken) {
      const agentApi = new OdyshellApi({
        serverUrl: resolved.serverUrl,
        agentToken: explicitAgentToken,
      });
      await agentApi.machines();
      await saveStoredConfig(
        {
          serverUrl: resolved.serverUrl,
          agentToken: explicitAgentToken,
          ...(resolved.adminKey ? { adminKey: resolved.adminKey } : {}),
          ...(resolved.workspaceId ? { workspaceId: resolved.workspaceId } : {}),
        },
        configPath,
      );
      if (options.json) {
        printJson({ authenticated: true, mode: "agent_token", serverUrl: resolved.serverUrl });
      } else {
        console.log(`${pc.green("✓")} Agent token verified`);
        console.log(pc.dim(`  Credentials saved to ${configPath}`));
      }
      return;
    }

    const authorization = await api.startDeviceAuthorization();
    if (options.json) {
      printJson({
        status: "authorization_required",
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        expiresIn: authorization.expiresIn,
      });
    } else {
      console.log(`Open ${pc.bold(authorization.verificationUri)}`);
      console.log(`Enter code ${pc.cyan(pc.bold(authorization.userCode))}`);
      console.log(pc.dim("Waiting for approval…"));
    }
    if (loginOptions.browser) {
      await open(authorization.verificationUriComplete, { wait: false }).catch(() => undefined);
    }

    const deadline = Date.now() + authorization.expiresIn * 1_000;
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, authorization.interval * 1_000),
      );
      try {
        const token = await api.exchangeDeviceAuthorization(authorization.deviceCode);
        const savedAdminKey = resolved.adminKey ?? previous?.adminKey;
        await saveStoredConfig(
          {
            serverUrl: resolved.serverUrl,
            workspaceId: token.workspaceId,
            cliToken: token.accessToken,
            ...(savedAdminKey ? { adminKey: savedAdminKey } : {}),
          },
          configPath,
        );
        if (options.json) {
          printJson({
            authenticated: true,
            mode: "web",
            serverUrl: resolved.serverUrl,
            workspaceId: token.workspaceId,
            expiresAt: token.expiresAt,
            configPath,
          });
        } else {
          console.log(`${pc.green("✓")} Signed in to ${pc.bold(resolved.serverUrl)}`);
          console.log(pc.dim(`  Credentials expire ${token.expiresAt}`));
          console.log(pc.dim(`  Credentials saved to ${configPath}`));
        }
        return;
      } catch (error) {
        if (
          error instanceof ApiError &&
          ["authorization_pending", "slow_down"].includes(error.code)
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new ExpectedError(
      "The login code expired. Run \"ods login\" to request a new one.",
      "device_code_expired",
    );
  });

program
  .command("logout")
  .description("remove locally stored credentials")
  .action(async (_options, command: Command) => {
    const options = globals(command);
    const configPath = options.configFile ? resolve(options.configFile) : defaultConfigPath();
    const stored = await loadStoredConfig(configPath);
    let revoked = false;
    if (stored?.cliToken) {
      revoked = await new OdyshellApi({
        serverUrl: stored.serverUrl,
        cliToken: stored.cliToken,
      })
        .logoutCli()
        .then(() => true)
        .catch(() => false);
    }
    await removeStoredConfig(configPath);
    if (options.json) printJson({ loggedOut: true, revoked, configPath });
    else {
      console.log(`${pc.green("✓")} Removed ${configPath}`);
      if (stored?.cliToken && !revoked) {
        console.error(
          pc.yellow("  The Server could not revoke this CLI token. It will remain valid until expiry."),
        );
      }
    }
  });

program
  .command("status")
  .description("check the server and connected machines")
  .action(async (_options, command: Command) => {
    const options = globals(command);
    const api = await apiFor(command);
    const [health, machines, localClient] = await Promise.all([
      api.health(),
      api.machines(),
      clientServiceStatus(),
    ]);
    if (options.json) printJson({ serverUrl: api.serverUrl, health, machines, localClient });
    else {
      console.log(`${pc.green("●")} ${pc.bold(api.serverUrl)}  protocol v${health.protocol}`);
      if (localClient.installed) {
        console.log(
          `Local Client  ${localClient.active ? pc.green("running") : pc.dim("stopped")}`,
        );
      }
      printMachines(machines);
    }
  });

const machine = program
  .command("machines")
  .alias("machine")
  .description("list enrolled machines")
  .option("--admin", "use administrator access and include revoked machines")
  .action(async (machineOptions: { admin?: boolean }, command: Command) => {
    const options = globals(command);
    const api = await apiFor(command);
    const machines = machineOptions.admin ? await api.adminMachines() : await api.machines();
    if (options.json) printJson({ data: machines });
    else printMachines(machines);
  });

machine
  .command("revoke <machine>")
  .description("revoke a machine identity and close its active access")
  .action(async (machineReference: string, _options, command: Command) => {
    const global = globals(command);
    const api = await apiFor(command);
    const [machineId] = await api.resolveAdminMachineIds([machineReference]);
    if (!machineId) {
      throw new ExpectedError(`Machine "${machineReference}" was not found`, "machine_not_found");
    }
    const result = await api.revokeMachine(machineId);
    if (global.json) printJson(result);
    else {
      console.log(`${pc.green("âœ“")} Revoked ${result.name} (${result.id})`);
      console.log(
        pc.dim(
          `  closed ${result.closedSessions} session(s), cancelled ${result.cancelledOperations} operation(s)`,
        ),
      );
    }
  });

program
  .command("ping <machine>")
  .description("check end-to-end access to a machine")
  .action(async (machineReference: string, _options, command: Command) => {
    const options = globals(command);
    const api = await apiFor(command);
    const machine = await api.resolveMachine(machineReference);
    const result = await api.ping(machine.id);
    if (options.json) printJson({ ...result, machineName: machine.name });
    else {
      console.log("Pong! 🏓");
      console.error(pc.dim(`  ${machine.name} ${result.latencyMs}ms`));
    }
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
  .option("--ttl <duration>", "token lifetime", "10m")
  .action(async (options: { ttl: string }, command: Command) => {
    const global = globals(command);
    const result = await (await apiFor(command)).createEnrollmentToken(
      parseDuration(options.ttl, "--ttl"),
    );
    if (global.json) printJson(result);
    else {
      console.log(result.token);
      console.error(pc.dim(`Expires ${new Date(result.expiresAt).toLocaleString()}`));
    }
  });

const agent = program.command("agent").description("manage scoped agent access");
agent
  .command("list")
  .description("list scoped agent access")
  .action(async (_options, command: Command) => {
    const global = globals(command);
    const agents = await (await apiFor(command)).agents();
    if (global.json) printJson({ data: agents });
    else printAgents(agents);
  });

agent
  .command("create <name>")
  .description("create a scoped agent token")
  .requiredOption("--machines <references>", "comma-separated machine names or IDs")
  .requiredOption("--allow <capabilities>", "comma-separated capabilities")
  .option("--for <duration>", "access lifetime", "1h")
  .option("--ttl <duration>", "access lifetime (alias for --for)")
  .action(
    async (
      name: string,
      options: { machines: string; allow: string; for: string; ttl?: string },
      command: Command,
    ) => {
      const global = globals(command);
      const machineReferences = [
        ...new Set(options.machines.split(",").map((reference) => reference.trim())),
      ].filter(Boolean);
      if (machineReferences.length === 0) {
        throw new ExpectedError(
          "At least one machine name or ID is required",
          "machine_references_required",
        );
      }
      const api = await apiFor(command);
      const machineIds = await api.resolveAdminMachineIds(machineReferences);
      const result = await api.createAgentToken(
        name,
        machineIds,
        parseCapabilities(options.allow),
        parseDuration(options.ttl ?? options.for, options.ttl ? "--ttl" : "--for"),
      );
      if (global.json) printJson(result);
      else {
        console.log(result.token);
        console.error(pc.dim(`Agent ${result.name} (${result.id})`));
        console.error(pc.dim(`Expires ${new Date(result.expiresAt).toLocaleString()}`));
      }
    },
  );

agent
  .command("revoke <agent-id>")
  .description("revoke access and close its active sessions")
  .action(async (agentId: string, _options, command: Command) => {
    const global = globals(command);
    const result = await (await apiFor(command)).revokeAgent(agentId);
    if (global.json) printJson(result);
    else {
      console.log(`${pc.green("✓")} Revoked ${result.name} (${result.id})`);
      console.log(pc.dim(`  closed ${result.closedSessions} active session(s)`));
    }
  });

program
  .command("audit")
  .description("show recent agent actions")
  .option("--limit <count>", "number of events", "50")
  .option("--all", "show all agents using administrator access")
  .action(async (options: { limit: string; all?: boolean }, command: Command) => {
    const global = globals(command);
    const result = await (await apiFor(command)).audit(Number(options.limit), options.all ?? false);
    if (global.json) printJson(result);
    else printAudit(result.principal, result.data);
  });

program
  .command("mcp")
  .description("serve Odyshell tools to AI agents over MCP stdio")
  .action(async (_options, command: Command) => {
    const config = await resolveConfig(globals(command));
    if (!config.agentToken) {
      throw new ExpectedError(
        "An agent token is required for MCP. Run \"ods login\" or set ODYSHELL_AGENT_TOKEN.",
        "agent_token_required",
      );
    }
    serveOdyshellMcp(
      new Odyshell({
        serverUrl: config.serverUrl,
        agentToken: config.agentToken,
      }),
    );
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
  .command("stat <machine> <path>")
  .description("inspect a file or directory")
  .action(async (machine: string, path: string, _options, command: Command) =>
    runInTemporarySession(
      command,
      machine,
      "fs.stat",
      { kind: "fs.stat", path },
      300,
      120,
    ),
  );

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
  .command("search <machine> <query> [path]")
  .description("find files and directories by name")
  .option("--limit <count>", "maximum results", "100")
  .action(
    async (
      machine: string,
      query: string,
      path: string | undefined,
      options: { limit: string },
      command: Command,
    ) =>
      runInTemporarySession(
        command,
        machine,
        "fs.search",
        {
          kind: "fs.search",
          path: path ?? ".",
          query,
          maxResults: Number(options.limit),
        },
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
        throw new ExpectedError(
          "Pass --content <text> or --file <path>",
          "file_content_required",
        );
      }
      if (options.content !== undefined && options.file) {
        throw new ExpectedError(
          "--content and --file are mutually exclusive",
          "file_content_conflict",
        );
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

fsCommand
  .command("mkdir <machine> <path>")
  .description("create a directory")
  .option("--no-recursive", "require the parent directory to exist")
  .action(
    async (
      machine: string,
      path: string,
      options: { recursive: boolean },
      command: Command,
    ) =>
      runInTemporarySession(
        command,
        machine,
        "fs.mkdir",
        { kind: "fs.mkdir", path, recursive: options.recursive },
        300,
        120,
      ),
  );

fsCommand
  .command("remove <machine> <path>")
  .description("remove a file or directory")
  .option("--recursive", "remove a directory and its contents")
  .action(
    async (
      machine: string,
      path: string,
      options: { recursive?: boolean },
      command: Command,
    ) =>
      runInTemporarySession(
        command,
        machine,
        "fs.remove",
        { kind: "fs.remove", path, recursive: options.recursive ?? false },
        300,
        120,
      ),
  );

const dockerCommand = program.command("docker").description("access Docker through typed operations");
dockerCommand
  .command("logs <machine> <container>")
  .description("read logs from a container on the host")
  .option("--tail <lines>", "number of lines", "200")
  .option("--timestamps", "include Docker timestamps")
  .action(
    async (
      machine: string,
      container: string,
      options: { tail: string; timestamps?: boolean },
      command: Command,
    ) =>
      runInTemporarySession(
        command,
        machine,
        "docker.logs",
        {
          kind: "docker.logs",
          container,
          tail: Number(options.tail),
          timestamps: options.timestamps ?? false,
        },
        300,
        120,
      ),
  );

program
  .command("up")
  .description("enroll this machine if needed and start its background Client")
  .option("--token <token>", "one-time enrollment token")
  .option("--name <name>", "machine name")
  .option("--workspace <path>", "workspace available to operations")
  .option("--allow <capabilities>", "comma-separated local capabilities")
  .option("--runner <runner>", "host or docker", "host")
  .option("--image <image>", "Docker profile image", "alpine:3.22")
  .option("--config <path>", "client configuration", defaultClientConfigPath())
  .action(
    async (
      options: {
        token?: string;
        name?: string;
        workspace?: string;
        allow?: string;
        runner: string;
        image: string;
        config: string;
      },
      command: Command,
    ) => {
      const global = globals(command);
      const configPath = resolve(options.config);
      const configFound = await access(configPath).then(
        () => true,
        () => false,
      );
      const enrollmentRequested =
        global.server !== undefined ||
        options.token !== undefined ||
        options.name !== undefined ||
        options.workspace !== undefined ||
        options.allow !== undefined ||
        command.getOptionValueSource("runner") === "cli" ||
        command.getOptionValueSource("image") === "cli";
      assertClientUpConfiguration({
        configExists: configFound,
        enrollmentRequested,
        configPath,
      });
      let enrollment:
        | { machineId: string; configPath: string }
        | undefined;
      if (!configFound) {
        const apiConfig = await resolveConfig(global);
        enrollment = await enrollClient({
          serverUrl: apiConfig.serverUrl,
          token: requiredValue(options.token, "--token"),
          machineName: requiredValue(options.name, "--name"),
          workspaceRoot: requiredValue(options.workspace, "--workspace"),
          allowedCapabilities: parseCapabilities(requiredValue(options.allow, "--allow")),
          runner: parseRunner(options.runner),
          image: options.image,
          configPath,
        });
      }
      let service;
      try {
        service = await installLinuxUserService({
          nodePath: process.execPath,
          cliPath: fileURLToPath(import.meta.url),
          configPath,
        });
      } catch (error) {
        throw new ExpectedError(
          `Could not start the Odyshell Client service: ${error instanceof Error ? error.message : String(error)}`,
          "client_service_start_failed",
        );
      }
      const result = {
        running: true,
        enrolled: Boolean(enrollment),
        ...(enrollment ?? {}),
        servicePath: service.servicePath,
        lingering: service.lingering,
      };
      if (global.json) printJson(result);
      else {
        console.log(`${pc.green("✓")} Odyshell Client is running`);
        if (enrollment) console.log(`  machine  ${enrollment.machineId}`);
        console.log(`  config   ${configPath}`);
        if (service.lingering === false) {
          console.log(
            pc.yellow(
              '  warning  Enable user lingering to reconnect after reboot: loginctl enable-linger "$USER"',
            ),
          );
        }
      }
    },
  );

program
  .command("down")
  .description("stop and disable this machine's background Client")
  .action(async (_options, command: Command) => {
    const global = globals(command);
    try {
      await stopLinuxUserService();
    } catch (error) {
      throw new ExpectedError(
        `Could not stop the Odyshell Client service: ${error instanceof Error ? error.message : String(error)}`,
        "client_service_stop_failed",
      );
    }
    if (global.json) printJson({ running: false });
    else console.log(`${pc.green("✓")} Odyshell Client stopped`);
  });

const client = program.command("client").description("manage the private-machine client");
client
  .command("doctor")
  .description("check this host for client compatibility")
  .option("--config <path>", "client configuration", defaultClientConfigPath())
  .option("--runner <runner>", "host or docker", "host")
  .action(async (options: { config: string; runner: string }, command: Command) => {
    const global = globals(command);
    const configPath = resolve(options.config);
    const configFound = await access(configPath).then(
      () => true,
      () => false,
    );
    const runtime = await inspectClientRuntime([parseRunner(options.runner)]);
    const report = { compatible: true, configPath, configFound, runtime };
    if (global.json) printJson(report);
    else {
      console.log(`${pc.green("✓")} ${runtime.hostPlatform}/${runtime.architecture}`);
      console.log(`  Node    ${runtime.nodeVersion}`);
      console.log(`  Runner  ${runtime.executionRunners?.join(", ") ?? "host"}`);
      if (runtime.containerEngineVersion) {
        console.log(
          `  Docker  ${runtime.containerEngineVersion} (${runtime.containerOs}/${runtime.containerArchitecture})`,
        );
      }
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
  .option("--runner <runner>", "host or docker", "host")
  .option("--image <image>", "sandbox image", "alpine:3.22")
  .option("--config <path>", "client configuration", defaultClientConfigPath())
  .action(
    async (
      options: {
        token: string;
        name: string;
        workspace: string;
        allow: string;
        runner: string;
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
        runner: parseRunner(options.runner),
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
  .command("status")
  .description("show the local background Client status")
  .action(async (_options, command: Command) => {
    const global = globals(command);
    const status = await clientServiceStatus();
    if (global.json) printJson(status);
    else {
      console.log(
        status.active
          ? `${pc.green("●")} Odyshell Client is running`
          : `${pc.dim("●")} Odyshell Client is stopped`,
      );
      if (status.servicePath) console.log(`  service  ${status.servicePath}`);
    }
  });

client
  .command("start")
  .description("start the outbound client in the foreground")
  .option("--config <path>", "client configuration", defaultClientConfigPath())
  .action(async (options: { config: string }) => {
    await runClient(options.config);
  });

await program.parseAsync(normalizeGlobalOptions(process.argv)).catch((error: unknown) => {
  printCliError(error, process.argv.includes("--json") || process.argv.includes("-j"));
  process.exitCode = 1;
});
