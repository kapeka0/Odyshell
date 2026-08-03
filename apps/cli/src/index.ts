import { access, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import open from "open";
import pc from "picocolors";
import {
  PROTOCOL_VERSION,
  clientConfigSchema,
  type OperationAction,
} from "@odyshell/protocol";
import {
  CLIENT_VERSION,
  clientConfigPathForProfile,
  defaultClientConfigPath,
  clientServiceStatus,
  enrollClient,
  inspectClientRuntime,
  installClientService,
  removeClientProfile,
  removeLinuxUserService,
  runClient,
  stopClientService,
} from "@odyshell/client";
import {
  ApiError,
  Odyshell,
  OdyshellApi,
  type Operation,
  type OperationResult,
} from "@odyshell/sdk";
import { parseDuration } from "./duration.js";
import { parseCapabilities } from "./capabilities.js";
import { ExpectedError, printCliError } from "./errors.js";
import {
  defaultConfigPath,
  loggedOutConfig,
  loadStoredConfig,
  removeStoredConfig,
  resolveConfig,
  saveStoredConfig,
  type GlobalOptions,
} from "./config.js";
import { updateClientPackage } from "./update.js";
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
import {
  assertClientServerReachable,
  resolveClientUpConfiguration,
} from "./up.js";
import {
  serveApprovedOdyshellMcp,
} from "./mcp.js";
import { deviceLoginUrl } from "./login.js";
import { resetLocalOdyshell } from "./reset.js";

const program = new Command();
program
  .name("ods")
  .description("Agent-first access to private machines")
  .version("0.12.1")
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

async function clientConfigurationFor(
  global: GlobalOptions,
  explicitConfigPath?: string,
  profileName = "default",
) {
  const apiConfig = await resolveConfig(global);
  const selected = await resolveClientUpConfiguration({
    serverUrl: apiConfig.serverUrl,
    ...(explicitConfigPath
      ? { explicitConfigPath: resolve(explicitConfigPath) }
      : {}),
    profileName,
    legacyConfigPath: defaultClientConfigPath(),
    profileConfigPath: clientConfigPathForProfile(profileName),
  });
  return { apiConfig, ...selected };
}

function assertProfileSelection(
  profileName: string | undefined,
  configPath: string | undefined,
): void {
  if (profileName && configPath) {
    throw new ExpectedError(
      'Use either "--profile <name>" or "--config <path>", not both.',
      "client_profile_config_conflict",
    );
  }
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
  action: OperationAction,
  ttlSeconds: number,
  timeoutSeconds: number,
): Promise<void> {
  const options = globals(command);
  if (action.kind === "process.shell") {
    throw new ExpectedError(
      'The "ods shell" flow is deprecated because free-form shell text cannot be safely scoped. Use "ods exec <machine> <program> [args...]" instead.',
      "process_shell_unsupported",
    );
  }
  const configPath = options.configFile
    ? resolve(options.configFile)
    : defaultConfigPath();
  const config = await resolveConfig(options);
  const api = new OdyshellApi(config);
  const machine = await api.resolveMachine(machineReference);
  const identity = {
    id: config.mcpAgentId ?? randomUUID(),
    name: config.mcpAgentName ?? "Odyshell CLI",
  };
  if ((!config.mcpAgentId || !config.mcpAgentName) && config.cliToken) {
    await saveStoredConfig(
      { ...config, mcpAgentId: identity.id, mcpAgentName: identity.name },
      configPath,
    );
  }
  if ((!config.mcpAgentId || !config.mcpAgentName) && !config.cliToken) {
    throw new ExpectedError(
      'Register this Agent with "ods agent login" before requesting a Session.',
      "agent_identity_required",
    );
  }
  const agent = api.agent(identity);
  const request = await agent.requestOperationSession({
    machineId: machine.id,
    title: `Run ${action.kind} on ${machine.name}`,
    purpose: `Run ${action.kind} on ${machine.name}`,
    action,
    durationSeconds: ttlSeconds,
  });
  if (request.status === "pending" && request.approvalUrl) {
    console.error("Approve this Session:");
    console.error(`  ${request.approvalUrl}`);
  }
  let requestStatus = await agent.status(request.id);
  while (requestStatus.status === "pending") {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    requestStatus = await agent.status(request.id);
  }
  if (requestStatus.status !== "approved") {
    throw new ExpectedError(
      `Session request ${requestStatus.status}.`,
      `session_request_${requestStatus.status}`,
    );
  }
  const claim = await agent.claim(request.id);
  try {
    const result = await api.claimedSession(claim).execute(
      machine.id,
      action,
      {
        timeoutSeconds,
        ...(options.json ? {} : { onEvent: streamEvent }),
      },
    );
    finishOperationResult(result, options.json ?? false);
  } finally {
    await agent.cancel(claim.sessionId).catch(() => undefined);
  }
}

function finishOperationResult(result: OperationResult, json: boolean): void {
  if (json) printJson(operationJson(result.operation));
  else if (result.operation.error) {
    console.error(pc.red(`\n${result.operation.error}`));
  }
  if (result.operation.status !== "succeeded") process.exitCode = 1;
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
          ...(previous?.mcpAgentId
            ? { mcpAgentId: previous.mcpAgentId }
            : {}),
          ...(previous?.mcpAgentName
            ? { mcpAgentName: previous.mcpAgentName }
            : {}),
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
    const loginUrl = deviceLoginUrl(
      authorization.verificationUri,
      authorization.userCode,
    );
    if (options.json) {
      printJson({
        status: "authorization_required",
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        verificationUriComplete: loginUrl,
        expiresIn: authorization.expiresIn,
      });
    } else {
      console.log("Open this link to approve login:");
      console.log(`  ${pc.cyan(pc.bold(loginUrl))}`);
      console.log(
        pc.dim(`  The code ${authorization.userCode} is already included in the link.`),
      );
      console.log(pc.dim("Waiting for approval…"));
    }
    if (loginOptions.browser) {
      await open(loginUrl, { wait: false }).catch(() => undefined);
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
            ...(previous?.mcpAgentId
              ? { mcpAgentId: previous.mcpAgentId }
              : {}),
            ...(previous?.mcpAgentName
              ? { mcpAgentName: previous.mcpAgentName }
              : {}),
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
          console.log(
            pc.dim(
              "  Login authorizes this CLI; connect a machine separately with the dashboard's ods up command.",
            ),
          );
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
    const retainedIdentity = loggedOutConfig(stored);
    if (retainedIdentity) {
      await saveStoredConfig(retainedIdentity, configPath);
    } else {
      await removeStoredConfig(configPath);
    }
    if (options.json) printJson({ loggedOut: true, revoked, configPath });
    else {
      console.log(`${pc.green("✓")} Removed local credentials`);
      if (retainedIdentity) {
        console.log(pc.dim("  MCP Agent identity preserved"));
      }
      if (stored?.cliToken && !revoked) {
        console.error(
          pc.yellow("  The Server could not revoke this CLI token. It will remain valid until expiry."),
        );
      }
    }
  });

program
  .command("reset")
  .description("sign out and remove every local Client Profile")
  .option("--yes", "confirm removal of all local Odyshell identities")
  .action(async (options: { yes?: boolean }, command: Command) => {
    if (!options.yes) {
      throw new ExpectedError(
        'Reset removes every local Client Profile. Re-run with "ods reset --yes" to confirm.',
        "reset_confirmation_required",
      );
    }
    const global = globals(command);
    const configPath = global.configFile
      ? resolve(global.configFile)
      : defaultConfigPath();
    let result;
    try {
      result = await resetLocalOdyshell({
        configPath,
        revokeCli: async (stored) =>
          new OdyshellApi({
            serverUrl: stored.serverUrl,
            cliToken: stored.cliToken,
          }).logoutCli().then(() => true),
      });
    } catch (error) {
      throw new ExpectedError(
        `Could not reset Odyshell: ${error instanceof Error ? error.message : String(error)}`,
        "reset_failed",
      );
    }
    if (global.json) {
      printJson({ ...result, configPath });
      return;
    }
    console.log(`${pc.green("✓")} Reset local Odyshell state`);
    console.log(`  profiles  ${result.removedProfiles.length}`);
    if (result.revocationAttempted && !result.revoked) {
      console.error(
        pc.yellow(
          "  warning   The Server could not revoke this CLI token. It remains valid until expiry.",
        ),
      );
    }
    console.log(pc.dim("  Cloud machine records remain available in the dashboard"));
  });

program
  .command("status")
  .description("check the server and connected machines")
  .action(async (_options, command: Command) => {
    const options = globals(command);
    const api = await apiFor(command);
    const localConfiguration = await clientConfigurationFor(options);
    const [health, machines, localClient] = await Promise.all([
      api.health(),
      api.machines(),
      localConfiguration.configExists
        ? clientServiceStatus(localConfiguration.configPath)
        : Promise.resolve({
            supported: ["linux", "darwin", "win32"].includes(process.platform),
            installed: false,
            active: false,
            enabled: false,
          }),
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
    const sessions = await (await apiFor(command)).agentSessions();
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

const agent = program.command("agent").description("manage Agent identities");
agent
  .command("login")
  .description("register this runtime as an Independent Agent")
  .argument("[name]", "persistent Agent name", "Odyshell Agent")
  .option("--no-browser", "do not open the verification page automatically")
  .action(
    async (
      name: string,
      options: { browser: boolean },
      command: Command,
    ) => {
      const global = globals(command);
      const configPath = global.configFile
        ? resolve(global.configFile)
        : defaultConfigPath();
      const previous = await loadStoredConfig(configPath);
      const resolved = await resolveConfig(global);
      const api = new OdyshellApi({ serverUrl: resolved.serverUrl });
      await api.health();
      const authorization = await api.startAgentDeviceAuthorization(name);
      const loginUrl = deviceLoginUrl(
        authorization.verificationUri,
        authorization.userCode,
      );
      if (global.json) {
        printJson({
          status: "authorization_required",
          userCode: authorization.userCode,
          verificationUriComplete: loginUrl,
          expiresIn: authorization.expiresIn,
        });
      } else {
        console.log("Open this link to register the Agent:");
        console.log(`  ${pc.cyan(pc.bold(loginUrl))}`);
        console.log(pc.dim("Waiting for approval…"));
      }
      if (options.browser) {
        await open(loginUrl, { wait: false }).catch(() => undefined);
      }
      const deadline = Date.now() + authorization.expiresIn * 1_000;
      while (Date.now() < deadline) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, authorization.interval * 1_000),
        );
        try {
          const token = await api.exchangeAgentDeviceAuthorization(
            authorization.deviceCode,
          );
          await saveStoredConfig(
            {
              serverUrl: resolved.serverUrl,
              workspaceId: token.workspaceId,
              agentToken: token.accessToken,
              mcpAgentId: token.agentId,
              mcpAgentName: token.agentName,
              ...(previous?.cliToken ? { cliToken: previous.cliToken } : {}),
              ...(previous?.adminKey ? { adminKey: previous.adminKey } : {}),
            },
            configPath,
          );
          if (global.json) {
            printJson({
              authenticated: true,
              mode: "agent",
              agentId: token.agentId,
              agentName: token.agentName,
              workspaceId: token.workspaceId,
              expiresAt: token.expiresAt,
              configPath,
            });
          } else {
            console.log(`${pc.green("✓")} Registered ${pc.bold(token.agentName)}`);
            console.log(pc.dim(`  Credential expires ${token.expiresAt}`));
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
        'The registration code expired. Run "ods agent login" again.',
        "device_code_expired",
      );
    },
  );

agent
  .command("list")
  .description("list Agent identities")
  .action(async (_options, command: Command) => {
    const global = globals(command);
    const agents = await (await apiFor(command)).agents();
    if (global.json) printJson({ data: agents });
    else printAgents(agents);
  });

agent
  .command("create <name>")
  .description("legacy command; Agents now register with agent login")
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
      void name;
      void options;
      void command;
      throw new ExpectedError(
        'Agent Access was migrated. Register once with "ods agent login", then request temporary Sessions.',
        "legacy_agent_access_migrated",
      );
    },
  );

agent
  .command("revoke <agent-id>")
  .description("legacy command; revoke the Agent Credential instead")
  .action(async (agentId: string, _options, command: Command) => {
    void agentId;
    void command;
    throw new ExpectedError(
      "Agent Access was migrated. Revoke the Agent Credential from the Agent runtime or disable the Agent.",
      "legacy_agent_access_migrated",
    );
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
  .option("--name <name>", "persistent agent name", "Odyshell MCP")
  .action(async (mcpOptions: { name: string }, command: Command) => {
    const global = globals(command);
    const configPath = global.configFile
      ? resolve(global.configFile)
      : defaultConfigPath();
    const config = await resolveConfig(global);
    if (config.agentToken && config.mcpAgentId && config.mcpAgentName) {
      serveApprovedOdyshellMcp(
        new Odyshell({
          serverUrl: config.serverUrl,
          agentToken: config.agentToken,
        }),
        { id: config.mcpAgentId, name: config.mcpAgentName },
      );
      return;
    }
    if (config.cliToken) {
      const agentId = config.mcpAgentId ?? randomUUID();
      const agentName = config.mcpAgentName ?? mcpOptions.name;
      if (!config.mcpAgentId || !config.mcpAgentName) {
        await saveStoredConfig(
          {
            ...config,
            mcpAgentId: agentId,
            mcpAgentName: agentName,
          },
          configPath,
        );
      }
      serveApprovedOdyshellMcp(
        new Odyshell({
          serverUrl: config.serverUrl,
          cliToken: config.cliToken,
        }),
        { id: agentId, name: agentName },
      );
      return;
    }
    if (!config.agentToken) {
      throw new ExpectedError(
        "Sign in with \"ods login\" or configure an agent token.",
        "mcp_credentials_required",
      );
    }
    throw new ExpectedError(
      'Agent Access was migrated. Register this Agent with "ods agent login".',
      "legacy_agent_access_migrated",
    );
  });

const session = program.command("session").description("manage persistent sessions");
session
  .command("create <machine>")
  .description("legacy command; Agents now request Sessions")
  .option("--ttl <seconds>", "session lifetime", "600")
  .requiredOption("--capabilities <items>", "comma-separated capabilities")
  .action(async (machineReference: string, options: { ttl: string; capabilities: string }, command: Command) => {
    void machineReference;
    void options;
    void command;
    throw new ExpectedError(
      'Direct Session creation was migrated. Use "ods exec" or the Agent Session request interface.',
      "legacy_session_creation_migrated",
    );
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
  .option("--cwd <path>", "base directory for relative paths", ".")
  .option("--allow <capabilities>", "comma-separated local capabilities")
  .option("--runner <runner>", "host or docker", "host")
  .option("--image <image>", "Docker profile image", "alpine:3.22")
  .option("--profile <name>", "Client Profile name")
  .option("--config <path>", "client configuration")
  .action(
    async (
      options: {
        token?: string;
        name?: string;
        cwd: string;
        allow?: string;
        runner: string;
        image: string;
        profile?: string;
        config?: string;
      },
      command: Command,
    ) => {
      const global = globals(command);
      assertProfileSelection(options.profile, options.config);
      const profileName = options.profile ?? "default";
      const {
        apiConfig,
        configPath,
        configExists: configFound,
        migratedFrom,
      } = await clientConfigurationFor(global, options.config, profileName);
      let enrollment:
        | { machineId: string; configPath: string }
        | undefined;
      const replaceEnrollment = configFound && options.token !== undefined;
      if (!configFound || replaceEnrollment) {
        const previousMachineId = replaceEnrollment
          ? await machineIdFromClientConfig(configPath)
          : undefined;
        enrollment = await enrollClient({
          serverUrl: apiConfig.serverUrl,
          token: requiredValue(options.token, "--token"),
          machineName: requiredValue(options.name, "--name"),
          workspaceRoot: resolve(options.cwd),
          allowedCapabilities: parseCapabilities(requiredValue(options.allow, "--allow")),
          runner: parseRunner(options.runner),
          image: options.image,
          configPath,
          profileName,
          ...(previousMachineId ? { previousMachineId } : {}),
          replaceConfig: replaceEnrollment,
        });
      }
      if (
        profileName === "default" &&
        !options.config &&
        process.platform === "linux"
      ) {
        try {
          await removeLinuxUserService(defaultClientConfigPath());
        } catch (error) {
          throw new ExpectedError(
            `Could not retire the legacy Odyshell Client service: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "client_profile_migration_failed",
          );
        }
      }
      await assertClientServerReachable(apiConfig.serverUrl);
      const previousStatus = configFound
        ? await clientServiceStatus(configPath)
        : undefined;
      let service;
      if (
        !enrollment &&
        previousStatus?.active &&
        previousStatus.current !== false
      ) {
        service = {
          servicePath: previousStatus.servicePath,
          lingering: undefined,
        };
      } else {
        try {
          service = await installClientService({
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
      }
      const result = {
        running: true,
        profile: profileName,
        enrolled: Boolean(enrollment),
        reenrolled: Boolean(enrollment && configFound),
        alreadyRunning: previousStatus?.active ?? false,
        enrollmentOptionsIgnored:
          configFound && !enrollment &&
          [options.token, options.name, options.allow].some(
            (value) => value !== undefined,
          ),
        ...(enrollment ?? {}),
        ...(migratedFrom ? { migratedFrom } : {}),
        servicePath: service.servicePath,
        lingering: service.lingering,
      };
      if (global.json) printJson(result);
      else {
        console.log(
          result.reenrolled
            ? `${pc.green("✓")} Odyshell Client identity replaced`
            : previousStatus?.active
            ? `${pc.green("✓")} Odyshell Client Profile is already running`
            : `${pc.green("✓")} Odyshell Client is running`,
        );
        console.log(`  profile  ${profileName}`);
        if (enrollment) console.log(`  machine  ${enrollment.machineId}`);
        else console.log("  machine  already enrolled with this server");
        if (result.enrollmentOptionsIgnored) {
          console.log(
            pc.yellow(
              "  note     Existing Profile kept unchanged; enrollment options were not applied",
            ),
          );
        }
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

async function machineIdFromClientConfig(configPath: string): Promise<string> {
  const parsed = clientConfigSchema.safeParse(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  if (!parsed.success) {
    throw new ExpectedError(
      `Client configuration at ${configPath} is invalid`,
      "client_config_invalid",
    );
  }
  return parsed.data.machineId;
}

program
  .command("down")
  .description("stop and disable this machine's background Client")
  .option("--profile <name>", "Client Profile name")
  .option("--config <path>", "client configuration")
  .action(async (options: { profile?: string; config?: string }, command: Command) => {
    const global = globals(command);
    assertProfileSelection(options.profile, options.config);
    const profileName = options.profile ?? "default";
    const { apiConfig, configPath, configExists } = await clientConfigurationFor(
      global,
      options.config,
      profileName,
    );
    if (!configExists) {
      throw new ExpectedError(
        `This machine is not enrolled with ${apiConfig.serverUrl}`,
        "client_not_enrolled",
      );
    }
    try {
      await stopClientService(configPath);
    } catch (error) {
      throw new ExpectedError(
        `Could not stop the Odyshell Client service: ${error instanceof Error ? error.message : String(error)}`,
        "client_service_stop_failed",
      );
    }
    if (global.json) printJson({ running: false, profile: profileName });
    else console.log(`${pc.green("✓")} Odyshell Client ${profileName} stopped`);
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
    const service = configFound
      ? await clientServiceStatus(configPath)
      : undefined;
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const compatible =
      nodeMajor >= 24 &&
      ["linux", "darwin", "win32"].includes(process.platform);
    const report = {
      compatible,
      version: CLIENT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      configPath,
      configFound,
      runtime,
      service,
    };
    if (global.json) printJson(report);
    else {
      console.log(`${pc.green("✓")} ${runtime.hostPlatform}/${runtime.architecture}`);
      console.log(`  Client  ${CLIENT_VERSION}`);
      console.log(`  Protocol  ${PROTOCOL_VERSION}`);
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
  .command("update")
  .description("install the latest compatible verified Client release")
  .option("--config <path>", "client configuration", defaultClientConfigPath())
  .option("--check", "check without installing")
  .action(
    async (
      options: { config: string; check?: boolean },
      command: Command,
    ) => {
      const global = globals(command);
      const result = await updateClientPackage(
        CLIENT_VERSION,
        resolve(options.config),
        options.check ?? false,
      );
      if (global.json) {
        printJson(result);
        return;
      }
      if (result.updated) {
        console.log(`${pc.green("✓")} Updated to ${result.latestVersion}`);
        if (result.restarted) console.log("  Client restarted");
      } else if (result.currentVersion === result.latestVersion) {
        console.log(`${pc.green("✓")} Client ${result.currentVersion} is current`);
      } else {
        console.log(`Client ${result.latestVersion} is available`);
      }
    },
  );

client
  .command("enroll")
  .description("enroll this machine with an Odyshell server")
  .requiredOption("--token <token>", "one-time enrollment token")
  .requiredOption("--name <name>", "machine name")
  .option("--cwd <path>", "base directory for relative paths", ".")
  .requiredOption("--allow <capabilities>", "comma-separated capabilities allowed by this machine")
  .option("--runner <runner>", "host or docker", "host")
  .option("--image <image>", "sandbox image", "alpine:3.22")
  .option("--config <path>", "client configuration", defaultClientConfigPath())
  .action(
    async (
      options: {
        token: string;
        name: string;
        cwd: string;
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
        workspaceRoot: resolve(options.cwd),
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
  .option("--profile <name>", "Client Profile name")
  .option("--config <path>", "client configuration")
  .action(async (options: { profile?: string; config?: string }, command: Command) => {
    const global = globals(command);
    assertProfileSelection(options.profile, options.config);
    const profileName = options.profile ?? "default";
    const { configPath, configExists } = await clientConfigurationFor(
      global,
      options.config,
      profileName,
    );
    const status = configExists
      ? await clientServiceStatus(configPath)
      : {
          supported: ["linux", "darwin", "win32"].includes(process.platform),
          installed: false,
          active: false,
          enabled: false,
        };
    if (global.json) printJson({ profile: profileName, ...status });
    else {
      console.log(
        status.active
          ? `${pc.green("●")} Odyshell Client is running`
          : `${pc.dim("●")} Odyshell Client is stopped`,
      );
      console.log(`  profile  ${profileName}`);
      if (status.servicePath) console.log(`  service  ${status.servicePath}`);
    }
  });

client
  .command("remove")
  .description("stop and delete one local Client Profile")
  .requiredOption("--profile <name>", "Client Profile name")
  .action(async (options: { profile: string }, command: Command) => {
    const global = globals(command);
    let result;
    try {
      result = await removeClientProfile({ profileName: options.profile });
    } catch (error) {
      throw new ExpectedError(
        `Could not remove Client Profile "${options.profile}": ${error instanceof Error ? error.message : String(error)}`,
        "client_profile_remove_failed",
      );
    }
    if (global.json) {
      printJson({ removed: true, ...result });
      return;
    }
    console.log(`${pc.green("✓")} Removed Client Profile ${result.profileName}`);
    console.log(pc.dim("  The Cloud machine remains available in the dashboard"));
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
