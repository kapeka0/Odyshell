import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import {
  DEFAULT_SERVER_URL,
  PROTOCOL_VERSION,
  clientConfigSchema,
} from "@odyshell/protocol";
import {
  CLIENT_VERSION,
  clientConfigPathForProfile,
  clientServiceStatus,
  enrollClient,
  inspectClientRuntime,
  installClientService,
  listClientProfiles,
  removeClientProfile,
  runClient,
  stopClientService,
} from "@odyshell/client";
import { ExpectedError, printCliError } from "./errors.js";
import { authenticatedFetch, login, logout } from "./auth.js";
import { printClientProfiles, printJson } from "./output.js";
import { resetLocalOdyshell } from "./reset.js";
import { updateClientPackage } from "./update.js";
import {
  assertClientServerReachable,
  assertSupportedClientHost,
  resolveClientUpConfiguration,
} from "./up.js";

type GlobalOptions = {
  json?: boolean;
  server?: string;
};

const program = new Command();
program
  .name("ods")
  .description("Install Machines and operate the Odyshell control plane")
  .version("0.20.0")
  .option("-j, --json", "emit stable JSON output")
  .option("--server <url>", "override the Odyshell Server URL")
  .showSuggestionAfterError()
  .showHelpAfterError();
program.enablePositionalOptions();

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function normalizeGlobalOptions(argv: string[]): string[] {
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
    if (argument === "--server" || argument.startsWith("--server=")) {
      globalArguments.push(argument);
      if (argument === "--server" && argv[index + 1] !== undefined) {
        globalArguments.push(argv[index + 1]!);
        index += 1;
      }
      continue;
    }
    commandArguments.push(argument);
  }
  return [...argv.slice(0, 2), ...globalArguments, ...commandArguments];
}

function selectedServerUrl(options: GlobalOptions): string {
  return options.server ?? DEFAULT_SERVER_URL;
}

function selectedServerOverride(options: GlobalOptions): string | undefined {
  return options.server;
}

async function cliJson(
  global: GlobalOptions,
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const response = await authenticatedFetch(path, init, selectedServerOverride(global));
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "cli_request_failed";
    throw new ExpectedError(`Odyshell rejected the request (${code}).`, code);
  }
  return body;
}

function show(global: GlobalOptions, value: unknown): void {
  if (global.json) printJson(value);
  else console.dir(value, { depth: 6, colors: process.stdout.isTTY });
}

const sessionDurations: Record<string, number> = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "2h": 2 * 60 * 60,
  "6h": 6 * 60 * 60,
  "8h": 8 * 60 * 60,
  "24h": 24 * 60 * 60,
};

program
  .command("login")
  .description("sign in through the browser for human control-plane access")
  .action(async (_options, command: Command) => {
    const global = globals(command);
    const result = await login(selectedServerUrl(global));
    if (global.json) printJson(result);
    else console.log(`${pc.green("OK")} Signed in to ${result.serverUrl}`);
  });

program
  .command("logout")
  .description("remove the local human OAuth session")
  .action(async (_options, command: Command) => {
    const result = { loggedOut: await logout() };
    if (globals(command).json) printJson(result);
    else console.log(`${pc.green("OK")} Signed out`);
  });

const machines = program.command("machines").description("inspect Organization Machines");
machines.command("list").alias("ls").action(async (_options, command: Command) => {
  const global = globals(command);
  const context = await cliJson(global, "/v1/cli/context");
  show(global, { data: context.machines });
});
machines.command("ping <machine-id>").action(async (machineId: string, _options, command: Command) => {
  const global = globals(command);
  show(global, await cliJson(global, `/v1/cli/machines/${encodeURIComponent(machineId)}/ping`, { method: "POST" }));
});

const agents = program.command("agents").description("inspect and administer Agents");
agents.command("list").alias("ls").action(async (_options, command: Command) => {
  const global = globals(command);
  const context = await cliJson(global, "/v1/cli/context");
  show(global, { data: context.agents });
});
agents.command("role <agent-id> <role>")
  .description("set an Agent role to standard or operator")
  .action(async (agentId: string, role: string, _options, command: Command) => {
    if (!['standard', 'operator'].includes(role)) {
      throw new ExpectedError("Role must be standard or operator.", "invalid_agent_role");
    }
    const global = globals(command);
    show(global, await cliJson(global, `/v1/cli/agents/${encodeURIComponent(agentId)}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }));
  });
agents.command("remove <agent-id>")
  .requiredOption("--yes", "confirm Agent and active Session revocation")
  .action(async (agentId: string, _options, command: Command) => {
    const global = globals(command);
    show(global, await cliJson(global, `/v1/cli/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }));
  });

const sessions = program.command("sessions").description("request, supervise, and inspect Sessions");
sessions.command("list").alias("ls").action(async (_options, command: Command) => {
  const global = globals(command);
  const context = await cliJson(global, "/v1/cli/context");
  show(global, { data: context.sessions });
});
sessions.command("request")
  .requiredOption("--machine <id>", "target Machine UUID")
  .requiredOption("--duration <duration>", "15m, 1h, 2h, 6h, 8h, or 24h")
  .requiredOption("--title <title>", "Session title")
  .option("--purpose <purpose>", "Session purpose")
  .action(async (options: { machine: string; duration: string; title: string; purpose?: string }, command: Command) => {
    const durationSeconds = sessionDurations[options.duration];
    if (!durationSeconds) throw new ExpectedError("Duration must be 15m, 1h, 2h, 6h, 8h, or 24h.", "invalid_session_duration");
    const global = globals(command);
    show(global, await cliJson(global, "/v1/sessions", {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: JSON.stringify({ machineId: options.machine, durationSeconds, title: options.title, ...(options.purpose ? { purpose: options.purpose } : {}) }),
    }));
  });
for (const decision of ["approve", "deny"] as const) {
  sessions.command(`${decision} <session-id>`).action(async (sessionId: string, _options, command: Command) => {
    const global = globals(command);
    show(global, await cliJson(global, `/v1/cli/sessions/${encodeURIComponent(sessionId)}/${decision}`, { method: "POST" }));
  });
}
sessions.command("timeline <session-id>").action(async (sessionId: string, _options, command: Command) => {
  const global = globals(command);
  show(global, await cliJson(global, `/v1/cli/sessions/${encodeURIComponent(sessionId)}/timeline`));
});
sessions.command("get <session-id>").action(async (sessionId: string, _options, command: Command) => {
  const global = globals(command);
  show(global, await cliJson(global, `/v1/sessions/${encodeURIComponent(sessionId)}`));
});
for (const outcome of ["complete", "cancel"] as const) {
  sessions.command(`${outcome} <session-id>`).action(async (sessionId: string, _options, command: Command) => {
    const global = globals(command);
    show(global, await cliJson(global, `/v1/sessions/${encodeURIComponent(sessionId)}/${outcome}`, {
      method: "POST", headers: { "idempotency-key": randomUUID() },
    }));
  });
}

const commands = program.command("commands").description("run and inspect commands inside Sessions");
commands.command("run <session-id>")
  .requiredOption("--command <command>", "shell command")
  .option("--cwd <path>", "absolute working directory")
  .option("--timeout <seconds>", "timeout in seconds", "600")
  .action(async (sessionId: string, options: { command: string; cwd?: string; timeout: string }, command: Command) => {
    const global = globals(command);
    show(global, await cliJson(global, `/v1/sessions/${encodeURIComponent(sessionId)}/commands`, {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: JSON.stringify({ command: options.command, timeoutSeconds: Number(options.timeout), ...(options.cwd ? { cwd: options.cwd } : {}) }),
    }));
  });
commands.command("get <command-id>").action(async (commandId: string, _options, command: Command) => {
  const global = globals(command);
  show(global, await cliJson(global, `/v1/commands/${encodeURIComponent(commandId)}`));
});
commands.command("output <command-id>")
  .option("--after <sequence>", "output cursor", "-1")
  .action(async (commandId: string, options: { after: string }, command: Command) => {
    const global = globals(command);
    const output = await cliJson(global, `/v1/commands/${encodeURIComponent(commandId)}/output?after=${encodeURIComponent(options.after)}`);
    if (global.json) printJson(output);
    else for (const chunk of output.data ?? []) process.stdout.write(Buffer.from(chunk.dataBase64, "base64"));
  });
commands.command("cancel <command-id>").action(async (commandId: string, _options, command: Command) => {
  const global = globals(command);
  show(global, await cliJson(global, `/v1/commands/${encodeURIComponent(commandId)}/cancel`, {
    method: "POST", headers: { "idempotency-key": randomUUID() },
  }));
});

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

function requiredValue(value: string | undefined, flag: string): string {
  if (value) return value;
  throw new ExpectedError(
    `${flag} is required when enrolling a new Machine`,
    "enrollment_option_required",
  );
}

async function clientConfigurationFor(
  global: GlobalOptions,
  explicitConfigPath?: string,
  profileName = "default",
) {
  const serverUrl = selectedServerUrl(global);
  const selected = await resolveClientUpConfiguration({
    serverUrl,
    ...(explicitConfigPath
      ? { explicitConfigPath: resolve(explicitConfigPath) }
      : {}),
    profileName,
    profileConfigPath: clientConfigPathForProfile(profileName),
  });
  return { serverUrl, ...selected };
}

program
  .command("up")
  .description("enroll this Machine and start its background Client")
  .option("--token <token>", "one-time enrollment token")
  .option("--name <name>", "Machine name")
  .option("--profile <name>", "Client Profile name")
  .option("--config <path>", "Client configuration")
  .action(async (options: {
    token?: string;
    name?: string;
    profile?: string;
    config?: string;
  }, command: Command) => {
    assertSupportedClientHost();
    const global = globals(command);
    assertProfileSelection(options.profile, options.config);
    const profileName = options.profile ?? "default";
    const { serverUrl, configPath, configExists } = await clientConfigurationFor(
      global,
      options.config,
      profileName,
    );
    let enrollment: { machineId: string; configPath: string } | undefined;
    const replaceEnrollment = configExists && options.token !== undefined;
    if (!configExists || replaceEnrollment) {
      const previousMachineId = replaceEnrollment
        ? await machineIdFromClientConfig(configPath)
        : undefined;
      enrollment = await enrollClient({
        serverUrl,
        token: requiredValue(options.token, "--token"),
        machineName: requiredValue(options.name, "--name"),
        configPath,
        profileName,
        ...(previousMachineId ? { previousMachineId } : {}),
        replaceConfig: replaceEnrollment,
      });
    }
    await assertClientServerReachable(serverUrl);
    const previousStatus = configExists
      ? await clientServiceStatus(configPath)
      : undefined;
    const service = !enrollment && previousStatus?.active && previousStatus.current !== false
      ? { servicePath: previousStatus.servicePath, lingering: undefined }
      : await installClientService({
          nodePath: process.execPath,
          cliPath: fileURLToPath(import.meta.url),
          configPath,
        }).catch((error: unknown) => {
          throw new ExpectedError(
            `Could not start the Odyshell Client service: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "client_service_start_failed",
          );
        });
    const result = {
      running: true,
      profile: profileName,
      enrolled: Boolean(enrollment),
      reenrolled: Boolean(enrollment && configExists),
      alreadyRunning: previousStatus?.active ?? false,
      enrollmentOptionsIgnored:
        configExists && !enrollment &&
        [options.token, options.name].some((value) => value !== undefined),
      ...(enrollment ?? {}),
      servicePath: service.servicePath,
      lingering: service.lingering,
    };
    if (global.json) {
      printJson(result);
      return;
    }
    console.log(
      result.reenrolled
        ? `${pc.green("OK")} Odyshell Machine identity replaced`
        : previousStatus?.active
          ? `${pc.green("OK")} Odyshell Client Profile is already running`
          : `${pc.green("OK")} Odyshell Client is running`,
    );
    console.log(`  profile  ${profileName}`);
    console.log(`  machine  ${enrollment?.machineId ?? "already enrolled"}`);
    if (result.enrollmentOptionsIgnored) {
      console.log(pc.yellow("  note     Existing Profile kept unchanged"));
    }
    console.log(`  config   ${configPath}`);
    if (service.lingering === false) {
      console.log(
        pc.yellow(
          '  warning  Enable user lingering after reviewing local policy: loginctl enable-linger "$USER"',
        ),
      );
    }
  });

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
  .description("stop and disable this Machine's background Client")
  .option("--profile <name>", "Client Profile name")
  .option("--config <path>", "Client configuration")
  .action(async (options: { profile?: string; config?: string }, command: Command) => {
    const global = globals(command);
    assertProfileSelection(options.profile, options.config);
    const profileName = options.profile ?? "default";
    const { serverUrl, configPath, configExists } = await clientConfigurationFor(
      global,
      options.config,
      profileName,
    );
    if (!configExists) {
      throw new ExpectedError(
        `This Machine is not enrolled with ${serverUrl}`,
        "client_not_enrolled",
      );
    }
    await stopClientService(configPath).catch((error: unknown) => {
      throw new ExpectedError(
        `Could not stop the Odyshell Client service: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "client_service_stop_failed",
      );
    });
    if (global.json) printJson({ running: false, profile: profileName });
    else console.log(`${pc.green("OK")} Odyshell Client ${profileName} stopped`);
  });

program
  .command("status")
  .description("show local Client Profiles and service state")
  .action(async (_options, command: Command) => {
    const global = globals(command);
    const profiles = await listClientProfiles();
    if (global.json) printJson({ data: profiles });
    else printClientProfiles(profiles);
  });

const profiles = program
  .command("profiles")
  .alias("profile")
  .description("manage local Client Profiles");

profiles
  .command("ls")
  .alias("list")
  .description("list local Client Profiles")
  .action(async (_options, command: Command) => {
    const global = globals(command);
    const listed = await listClientProfiles();
    if (global.json) printJson({ data: listed });
    else printClientProfiles(listed);
  });

profiles
  .command("status <name>")
  .description("show one local Client Profile")
  .action(async (name: string, _options, command: Command) => {
    const global = globals(command);
    const profile = (await listClientProfiles())
      .find((candidate) => candidate.profileName === name);
    if (!profile) {
      throw new ExpectedError(
        `Client Profile "${name}" does not exist`,
        "client_profile_not_found",
      );
    }
    if (global.json) printJson(profile);
    else printClientProfiles([profile]);
  });

profiles
  .command("remove <name>")
  .alias("rm")
  .description("stop and delete one local Client Profile")
  .action(async (name: string, _options, command: Command) => {
    const global = globals(command);
    const result = await removeClientProfile({ profileName: name })
      .catch((error: unknown) => {
        throw new ExpectedError(
          `Could not remove Client Profile "${name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          "client_profile_remove_failed",
        );
      });
    if (global.json) printJson({ removed: true, ...result });
    else {
      console.log(`${pc.green("OK")} Removed Client Profile ${result.profileName}`);
      console.log(pc.dim("  The Machine record remains available in the dashboard"));
    }
  });

program
  .command("reset")
  .description("remove every local Client Profile")
  .option("--yes", "confirm removal of all local Machine identities")
  .action(async (options: { yes?: boolean }, command: Command) => {
    if (!options.yes) {
      throw new ExpectedError(
        'Reset removes every local Client Profile. Re-run with "ods reset --yes" to confirm.',
        "reset_confirmation_required",
      );
    }
    const result = await resetLocalOdyshell().catch((error: unknown) => {
      throw new ExpectedError(
        `Could not reset Odyshell: ${error instanceof Error ? error.message : String(error)}`,
        "reset_failed",
      );
    });
    if (globals(command).json) printJson(result);
    else {
      console.log(`${pc.green("OK")} Reset local Odyshell state`);
      console.log(`  profiles  ${result.removedProfiles.length}`);
      console.log(pc.dim("  Machine records remain available in the dashboard"));
    }
  });

const client = program
  .command("client")
  .description("diagnose and run the private-Machine Client");

client
  .command("doctor")
  .description("check this host for Client compatibility")
  .option("--profile <name>", "Client Profile name")
  .option("--config <path>", "Client configuration")
  .action(async (options: { profile?: string; config?: string }, command: Command) => {
    const global = globals(command);
    assertProfileSelection(options.profile, options.config);
    const profileName = options.profile ?? "default";
    const configPath = resolve(
      options.config ?? clientConfigPathForProfile(profileName),
    );
    const configFound = await access(configPath).then(() => true, () => false);
    const runtime = await inspectClientRuntime();
    const service = configFound ? await clientServiceStatus(configPath) : undefined;
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const compatible = nodeMajor >= 24 && ["linux", "darwin", "win32"].includes(process.platform);
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
      console.log(`${compatible ? pc.green("OK") : pc.red("NO")} ${runtime.hostPlatform}/${runtime.architecture}`);
      console.log(`  Client    ${CLIENT_VERSION}`);
      console.log(`  Protocol  ${PROTOCOL_VERSION}`);
      console.log(`  Node      ${runtime.nodeVersion}`);
      console.log(`  Config    ${configFound ? configPath : `${configPath} (not enrolled)`}`);
    }
  });

client
  .command("update")
  .description("install the latest compatible verified Client release")
  .option("--profile <name>", "Client Profile name")
  .option("--config <path>", "Client configuration")
  .option("--check", "check without installing")
  .action(async (options: {
    profile?: string;
    config?: string;
    check?: boolean;
  }, command: Command) => {
    assertProfileSelection(options.profile, options.config);
    const configPath = resolve(
      options.config ?? clientConfigPathForProfile(options.profile ?? "default"),
    );
    const result = await updateClientPackage(
      CLIENT_VERSION,
      configPath,
      options.check ?? false,
    );
    if (globals(command).json) {
      printJson(result);
      return;
    }
    if (result.updated) {
      console.log(`${pc.green("OK")} Updated to ${result.latestVersion}`);
      if (result.restarted) console.log("  Client restarted");
    } else if (result.currentVersion === result.latestVersion) {
      console.log(`${pc.green("OK")} Client ${result.currentVersion} is current`);
    } else {
      console.log(`Client ${result.latestVersion} is available`);
    }
  });

client
  .command("status")
  .description("show one local background Client service")
  .option("--profile <name>", "Client Profile name")
  .option("--config <path>", "Client configuration")
  .action(async (options: { profile?: string; config?: string }, command: Command) => {
    const global = globals(command);
    assertProfileSelection(options.profile, options.config);
    const profileName = options.profile ?? "default";
    const configPath = resolve(
      options.config ?? clientConfigPathForProfile(profileName),
    );
    const configFound = await access(configPath).then(() => true, () => false);
    const status = configFound
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
          ? `${pc.green("ONLINE")} Odyshell Client is running`
          : `${pc.dim("OFFLINE")} Odyshell Client is stopped`,
      );
      console.log(`  profile  ${profileName}`);
      if (status.servicePath) console.log(`  service  ${status.servicePath}`);
    }
  });

client
  .command("start")
  .description("start the outbound Client in the foreground")
  .requiredOption("--config <path>", "Client configuration")
  .action(async (options: { config: string }) => {
    assertSupportedClientHost();
    await runClient(options.config);
  });

await program.parseAsync(normalizeGlobalOptions(process.argv)).catch((error: unknown) => {
  printCliError(error, process.argv.includes("--json") || process.argv.includes("-j"));
  process.exitCode = 1;
});
