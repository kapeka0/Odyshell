import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
let apiUrl;
const agentKey = process.env.ODYSHELL_AGENT_KEY ?? "dev-agent-key";
const adminKey = process.env.ODYSHELL_ADMIN_KEY ?? "dev-admin-key";
const composeProject = `odyshell-e2e-${process.pid}`;
const composeEnvironment = {
  ...process.env,
  ODYSHELL_BIND_ADDRESS: "127.0.0.1",
  ODYSHELL_SERVER_PORT: "0",
  ODYSHELL_POSTGRES_PORT: "0",
  ODYSHELL_AGENT_KEY: agentKey,
  ODYSHELL_ADMIN_KEY: adminKey,
  ODYSHELL_ALLOW_DEV_CREDENTIALS: "true",
};
const configDirectory = resolve(root, `.odyshell/e2e/${process.pid}`);
const configPath = resolve(configDirectory, "client.json");
const workspace = resolve(root, `tmp/e2e-workspace-${process.pid}`);
let client;
let e2eMachineId;
const allCapabilities = [
  "process.exec",
  "process.shell",
  "fs.stat",
  "fs.list",
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.remove",
];
const clientCapabilities = allCapabilities.filter(
  (capability) => capability !== "process.shell",
);

if (!configDirectory.startsWith(resolve(root, ".odyshell"))) {
  throw new Error("Refusing to clean an E2E path outside .odyshell");
}
await rm(configDirectory, { recursive: true, force: true });
await mkdir(configDirectory, { recursive: true });
await mkdir(workspace, { recursive: true });

async function api(path, options = {}) {
  const response = await fetch(new URL(path, apiUrl), {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      "x-odyshell-agent-key": agentKey,
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8") || `${command} exited ${code}`));
    });
  });
}

function compose(args) {
  return run(
    "docker",
    ["compose", "--project-name", composeProject, ...args],
    { env: composeEnvironment },
  );
}

async function waitUntil(read, predicate, description) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function operation(sessionId, action, expectedStatus = "succeeded") {
  const created = await api(`/v1/sessions/${sessionId}/operations`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ action, timeoutSeconds: 10, maxOutputBytes: 1024 * 1024 }),
  });
  const completed = await waitUntil(
    () => api(`/v1/operations/${created.id}`),
    (value) => !["queued", "delivered", "running"].includes(value.status),
    `operation ${created.id}`,
  );
  if (completed.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus}, received ${completed.status}: ${completed.error ?? ""}`);
  }
  return {
    ...completed,
    output: completed.events
      .map((event) => Buffer.from(event.dataBase64, "base64").toString("utf8"))
      .join(""),
  };
}

try {
  await compose(["up", "-d", "--build", "--remove-orphans"]);

  const publishedAddresses = (await compose(["port", "server", "4100"]))
    .trim()
    .split(/\r?\n/);
  const published = publishedAddresses[0];
  if (!published) throw new Error("Docker Compose did not publish the Server port");
  const separator = published.lastIndexOf(":");
  if (separator <= 0) throw new Error(`Could not parse published Server address: ${published}`);
  const rawHost = published.slice(0, separator).replace(/^\[|\]$/g, "");
  const port = published.slice(separator + 1);
  const host = rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
  apiUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await api("/health");
      break;
    } catch {
      if (attempt === 59) throw new Error("Server did not become healthy");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }

  const enrollment = await api("/v1/admin/enrollment-tokens", {
    method: "POST",
    headers: { "x-odyshell-admin-key": adminKey },
    body: JSON.stringify({ expiresInSeconds: 600 }),
  });

  const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
  const clientEntry = resolve(root, "apps/client/src/cli.ts");
  const odsEntry = resolve(root, "apps/cli/src/index.ts");

  const enrolled = JSON.parse(
    await run(
      process.execPath,
      [
        tsxCli,
        odsEntry,
        "--server",
        apiUrl,
        "--json",
        "client",
        "enroll",
        "--token",
        enrollment.token,
        "--name",
        "e2e-docker",
        "--workspace",
        workspace,
        "--allow",
        clientCapabilities.join(","),
        "--runner",
        "docker",
        "--config",
        configPath,
      ],
    ),
  );

  client = spawn(
    process.execPath,
    [tsxCli, clientEntry, "start", "--config", configPath],
    {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  client.stdout.on("data", (chunk) => process.stdout.write(`[client] ${chunk}`));
  client.stderr.on("data", (chunk) => process.stderr.write(`[client] ${chunk}`));

  const machines = await waitUntil(
    () => api("/v1/machines"),
    (value) =>
      value.data.some((machine) => machine.id === enrolled.machineId && machine.online),
    "client authentication",
  );
  const machine = machines.data.find(
    (item) => item.id === enrolled.machineId && item.online,
  );
  if (!machine) throw new Error("Enrolled client did not come online");
  if (
    !["linux", "macos", "windows"].includes(machine.runtime?.hostPlatform) ||
    !machine.runtime?.architecture ||
    machine.runtime?.containerOs !== "linux"
  ) {
    throw new Error("Client runtime metadata was not reported");
  }
  e2eMachineId = machine.id;

  const scopedAgent = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--admin-key",
      adminKey,
      "--json",
      "agent",
      "create",
      "e2e-exec-agent",
      "--machines",
      machine.id,
      "--allow",
      "process.exec",
      "--ttl",
      "600",
    ]),
  );

  const scopedMachines = await api("/v1/machines", {
    headers: { authorization: `Bearer ${scopedAgent.token}` },
  });
  if (
    scopedMachines.data.length !== 1 ||
    scopedMachines.data[0]?.id !== machine.id
  ) {
    throw new Error("Scoped agent could access machines outside its token scope");
  }

  const listedAgents = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--admin-key",
      adminKey,
      "--json",
      "agent",
      "list",
    ]),
  );
  if (!listedAgents.data.some((item) => item.id === scopedAgent.id && item.status === "active")) {
    throw new Error("ods agent list did not show active scoped access");
  }

  const deniedSession = await fetch(new URL("/v1/sessions", apiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${scopedAgent.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      machineId: machine.id,
      profile: "workspace",
      ttlSeconds: 120,
      capabilities: ["process.shell"],
    }),
  });
  if (deniedSession.status !== 403) {
    throw new Error("Scoped agent was allowed to exceed its capability scope");
  }

  const locallyDenied = await api("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      machineId: machine.id,
      profile: "workspace",
      ttlSeconds: 120,
      capabilities: ["process.shell"],
    }),
  });
  const locallyDeniedSession = await waitUntil(
    () => api(`/v1/sessions/${locallyDenied.id}`),
    (value) => value.status === "failed",
    "client policy denial",
  );
  if (!locallyDeniedSession.error?.includes("denied by local policy")) {
    throw new Error("Client did not enforce its local capability policy");
  }

  const cliMachines = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--agent-token",
      scopedAgent.token,
      "--json",
      "machines",
    ]),
  );
  if (!cliMachines.data.some((item) => item.id === machine.id)) {
    throw new Error("ods machines did not return the enrolled client");
  }

  const cliPing = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--agent-token",
      scopedAgent.token,
      "--json",
      "ping",
      "e2e-docker",
    ]),
  );
  if (cliPing.reply !== "pong" || cliPing.machineId !== machine.id) {
    throw new Error("ods ping did not complete an end-to-end client round trip");
  }
  const cliPingText = await run(process.execPath, [
    tsxCli,
    odsEntry,
    "--server",
    apiUrl,
    "--agent-token",
    scopedAgent.token,
    "ping",
    "e2e-docker",
  ]);
  if (cliPingText.trim() !== "Pong! 🏓") {
    throw new Error("ods ping did not print the expected pong");
  }

  const cliExecution = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--agent-token",
      scopedAgent.token,
      "--json",
      "exec",
      "e2e-docker",
      "printf",
      "hello from ods CLI",
    ]),
  );
  if (cliExecution.output.stdout !== "hello from ods CLI") {
    throw new Error("ods one-shot execution did not return expected output");
  }

  const readOnlyCreated = await api("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      machineId: machine.id,
      profile: "workspace",
      ttlSeconds: 120,
      capabilities: ["process.exec"],
    }),
  });
  const readOnlySession = await waitUntil(
    () => api(`/v1/sessions/${readOnlyCreated.id}`),
    (value) => value.status === "ready" || value.status === "failed",
    "read-only sandbox creation",
  );
  if (readOnlySession.status !== "ready") {
    throw new Error(`Read-only sandbox failed: ${readOnlySession.error}`);
  }
  const readOnlyContainerId = (
    await run("docker", ["ps", "-q", "--filter", `label=odyshell.session=${readOnlySession.id}`])
  ).trim();
  const readOnlyInspect = JSON.parse(await run("docker", ["inspect", readOnlyContainerId]))[0];
  const readOnlyWorkspace = readOnlyInspect.Mounts.find(
    (mount) => mount.Destination === "/workspace",
  );
  if (readOnlyWorkspace?.RW !== false || readOnlyInspect.HostConfig.IpcMode !== "none") {
    throw new Error("Read-only session did not enforce workspace and IPC isolation");
  }
  await operation(
    readOnlySession.id,
    {
      kind: "process.exec",
      program: "touch",
      args: ["should-not-be-written"],
      cwd: ".",
      env: {},
    },
    "failed",
  );
  await api(`/v1/sessions/${readOnlySession.id}`, { method: "DELETE" });
  await waitUntil(
    () => api(`/v1/sessions/${readOnlySession.id}`),
    (value) => value.status === "closed",
    "read-only sandbox cleanup",
  );

  const createdSession = await api("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      machineId: machine.id,
      profile: "workspace",
      ttlSeconds: 120,
      capabilities: clientCapabilities,
    }),
  });
  const session = await waitUntil(
    () => api(`/v1/sessions/${createdSession.id}`),
    (value) => value.status === "ready" || value.status === "failed",
    "sandbox creation",
  );
  if (session.status !== "ready") throw new Error(`Sandbox failed: ${session.error}`);

  const containerId = (
    await run("docker", ["ps", "-q", "--filter", `label=odyshell.session=${session.id}`])
  ).trim();
  const inspected = JSON.parse(await run("docker", ["inspect", containerId]))[0];
  const workspaceMount = inspected.Mounts.find((mount) => mount.Destination === "/workspace");
  if (
    inspected.HostConfig.NetworkMode !== "none" ||
    inspected.HostConfig.IpcMode !== "none" ||
    !inspected.HostConfig.ReadonlyRootfs ||
    !inspected.HostConfig.CapDrop.includes("ALL") ||
    !inspected.HostConfig.SecurityOpt.includes("no-new-privileges:true") ||
    workspaceMount?.RW !== true
  ) {
    throw new Error("Session container does not match the required sandbox policy");
  }

  const execResult = await operation(session.id, {
    kind: "process.exec",
    program: "printf",
    args: ["hello from isolated Odyshell\\n"],
    cwd: ".",
    env: {},
  });
  if (!execResult.output.includes("hello from isolated Odyshell")) {
    throw new Error("Structured execution output was not relayed");
  }

  await operation(session.id, {
    kind: "fs.write",
    path: "odyshell-e2e.txt",
    contentBase64: Buffer.from("filesystem round trip").toString("base64"),
    createParents: true,
  });
  const readResult = await operation(session.id, { kind: "fs.read", path: "odyshell-e2e.txt" });
  if (readResult.output !== "filesystem round trip") throw new Error("Filesystem round trip failed");

  const networkResult = await operation(
    session.id,
    {
      kind: "process.exec",
      program: "wget",
      args: ["-T", "2", "-qO-", "http://example.com"],
      cwd: ".",
      env: {},
    },
    "failed",
  );

  const traversal = await fetch(new URL(`/v1/sessions/${session.id}/operations`, apiUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-odyshell-agent-key": agentKey,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      action: { kind: "fs.read", path: "../../etc/passwd" },
      timeoutSeconds: 10,
      maxOutputBytes: 1024,
    }),
  });
  if (traversal.status !== 400) throw new Error("Path traversal request was not rejected");

  const cancellable = await api(`/v1/sessions/${session.id}/operations`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      action: { kind: "process.exec", program: "sleep", args: ["30"], cwd: ".", env: {} },
      timeoutSeconds: 60,
      maxOutputBytes: 1024,
    }),
  });
  await waitUntil(
    () => api(`/v1/operations/${cancellable.id}`),
    (value) => value.status === "running",
    "cancellable operation startup",
  );
  await api(`/v1/operations/${cancellable.id}/cancel`, { method: "POST" });
  const cancelled = await waitUntil(
    () => api(`/v1/operations/${cancellable.id}`),
    (value) => !["queued", "delivered", "running"].includes(value.status),
    "operation cancellation",
  );
  if (cancelled.status !== "cancelled") throw new Error(`Cancellation produced ${cancelled.status}`);

  const scopedAudit = await waitUntil(
    () =>
      api("/v1/audit?limit=100", {
        headers: { authorization: `Bearer ${scopedAgent.token}` },
      }),
    (value) => value.data.some((event) => event.action === "operation.completed"),
    "scoped agent audit event",
  );
  if (
    scopedAudit.principal.id !== scopedAgent.id ||
    scopedAudit.data.some((event) => event.principalId !== scopedAgent.id)
  ) {
    throw new Error("Audit feed leaked events from another principal");
  }
  const cliAudit = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--agent-token",
      scopedAgent.token,
      "--json",
      "audit",
      "--limit",
      "100",
    ]),
  );
  if (!cliAudit.data.some((event) => event.action === "operation.completed")) {
    throw new Error("ods audit did not return the scoped agent history");
  }
  const adminAudit = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--admin-key",
      adminKey,
      "--json",
      "audit",
      "--all",
      "--limit",
      "200",
    ]),
  );
  if (
    adminAudit.principal.id !== "admin" ||
    !adminAudit.data.some(
      (event) =>
        event.principalId === scopedAgent.id &&
        event.action === "operation.completed",
    )
  ) {
    throw new Error("Administrator audit did not include scoped agent activity");
  }

  const boundedSessionResponse = await fetch(new URL("/v1/sessions", apiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${scopedAgent.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      machineId: machine.id,
      profile: "workspace",
      ttlSeconds: 3600,
      capabilities: ["process.exec"],
    }),
  });
  const boundedSession = await boundedSessionResponse.json();
  if (
    !boundedSessionResponse.ok ||
    new Date(boundedSession.expiresAt).getTime() > new Date(scopedAgent.expiresAt).getTime()
  ) {
    throw new Error("Session expiry was not bounded by its agent token");
  }
  await waitUntil(
    () =>
      api(`/v1/sessions/${boundedSession.id}`, {
        headers: { authorization: `Bearer ${scopedAgent.token}` },
      }),
    (value) => value.status === "ready",
    "bounded scoped session",
  );

  const revokedAgent = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--admin-key",
      adminKey,
      "--json",
      "agent",
      "revoke",
      scopedAgent.id,
    ]),
  );
  if (revokedAgent.status !== "revoked" || revokedAgent.closedSessions < 1) {
    throw new Error("Revoking agent access did not close its active session");
  }
  const revokedAccess = await fetch(new URL("/v1/machines", apiUrl), {
    headers: { authorization: `Bearer ${scopedAgent.token}` },
  });
  if (revokedAccess.status !== 401) {
    throw new Error("Revoked agent token remained usable");
  }
  await waitUntil(
    () => run("docker", ["ps", "-q", "--filter", `label=odyshell.session=${boundedSession.id}`]),
    (value) => value.trim() === "",
    "revoked agent session cleanup",
  );

  await api(`/v1/sessions/${session.id}`, { method: "DELETE" });
  await waitUntil(
    () => api(`/v1/sessions/${session.id}`),
    (value) => value.status === "closed",
    "session cleanup",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        machineId: machine.id,
        sessionId: session.id,
        checks: {
          outboundClient: true,
          ed25519Authentication: true,
          runtimeMetadata: `${machine.runtime.hostPlatform}/${machine.runtime.architecture}`,
          odsCli: true,
          odsPing: true,
          scopedAgentToken: true,
          agentAccessListed: true,
          agentAccessRevoked: true,
          sessionBoundedByToken: true,
          capabilityScopeDenied: true,
          clientPolicyDenied: true,
          auditTrail: true,
          administratorAudit: true,
          sandboxPolicy: true,
          readOnlyWorkspaceByDefault: true,
          ipcIsolated: true,
          sandboxedExec: execResult.output.trim(),
          filesystemRoundTrip: readResult.output,
          networkBlocked: networkResult.status === "failed",
          traversalRejected: true,
          cancellation: true,
          sessionDestroyed: true,
        },
      },
      null,
      2,
    ),
  );
} finally {
  if (e2eMachineId) {
    const orphanIds = (
      await run("docker", ["ps", "-aq", "--filter", `label=odyshell.machine=${e2eMachineId}`]).catch(
        () => "",
      )
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (orphanIds.length > 0) await run("docker", ["rm", "-f", ...orphanIds]).catch(() => {});
  }
  if (client?.pid && process.platform === "win32") {
    await run("taskkill.exe", ["/pid", String(client.pid), "/t", "/f"]).catch(() => {});
  } else if (client) {
    client.kill("SIGTERM");
  }
  await compose(["down", "--volumes", "--remove-orphans"]);
  await rm(configDirectory, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}
