import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
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

  const organization = await api("/v1/admin/organizations", {
    method: "POST",
    headers: { "x-odyshell-admin-key": adminKey },
    body: JSON.stringify({ slug: "e2e-customer", name: "E2E Customer" }),
  });
  const isolatedWorkspace = await api(
    `/v1/admin/organizations/${organization.id}/workspaces`,
    {
      method: "POST",
      headers: { "x-odyshell-admin-key": adminKey },
      body: JSON.stringify({ slug: "production", name: "Production" }),
    },
  );
  const secondOrganization = await api("/v1/admin/organizations", {
    method: "POST",
    headers: { "x-odyshell-admin-key": adminKey },
    body: JSON.stringify({ slug: "e2e-customer-two", name: "E2E Customer Two" }),
  });
  const repeatedSlugWorkspace = await api(
    `/v1/admin/organizations/${secondOrganization.id}/workspaces`,
    {
      method: "POST",
      headers: { "x-odyshell-admin-key": adminKey },
      body: JSON.stringify({ slug: "production", name: "Production" }),
    },
  );
  if (repeatedSlugWorkspace.organizationId !== secondOrganization.id) {
    throw new Error("Workspace slug was not scoped to its organization");
  }
  const isolatedEnrollment = await api("/v1/admin/enrollment-tokens", {
    method: "POST",
    headers: {
      "x-odyshell-admin-key": adminKey,
      "x-odyshell-workspace-id": isolatedWorkspace.id,
    },
    body: JSON.stringify({ expiresInSeconds: 600 }),
  });
  const isolatedKeyPair = generateKeyPairSync("ed25519");
  const isolatedMachine = await api("/v1/clients/enroll", {
    method: "POST",
    body: JSON.stringify({
      token: isolatedEnrollment.token,
      name: "isolated-machine",
      publicKey: isolatedKeyPair.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    }),
  });
  if (isolatedMachine.workspaceId !== isolatedWorkspace.id) {
    throw new Error("Enrollment token did not bind the machine to its workspace");
  }
  const isolatedAgent = await api("/v1/admin/agent-tokens", {
    method: "POST",
    headers: {
      "x-odyshell-admin-key": adminKey,
      "x-odyshell-workspace-id": isolatedWorkspace.id,
    },
    body: JSON.stringify({
      name: "isolated-agent",
      machineIds: [isolatedMachine.machineId],
      capabilities: ["process.exec"],
      expiresInSeconds: 600,
    }),
  });
  const isolatedAgentMachines = await api("/v1/machines", {
    headers: { authorization: `Bearer ${isolatedAgent.token}` },
  });
  if (
    isolatedAgentMachines.data.length !== 1 ||
    isolatedAgentMachines.data[0]?.id !== isolatedMachine.machineId
  ) {
    throw new Error("Agent token did not inherit its workspace boundary");
  }
  const defaultMachinesBeforeEnrollment = await api("/v1/machines");
  if (
    defaultMachinesBeforeEnrollment.data.some(
      (item) => item.id === isolatedMachine.machineId,
    )
  ) {
    throw new Error("Default workspace listed a machine from another workspace");
  }

  const enrollment = await api("/v1/admin/enrollment-tokens", {
    method: "POST",
    headers: { "x-odyshell-admin-key": adminKey },
    body: JSON.stringify({ expiresInSeconds: 600 }),
  });

  const replayEnrollment = await api("/v1/admin/enrollment-tokens", {
    method: "POST",
    headers: { "x-odyshell-admin-key": adminKey },
    body: JSON.stringify({ expiresInSeconds: 600 }),
  });
  const replayPublicKey = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const enrollmentAttempts = await Promise.all(
    ["enrollment-race-a", "enrollment-race-b"].map((name) =>
      fetch(new URL("/v1/clients/enroll", apiUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: replayEnrollment.token,
          name,
          publicKey: replayPublicKey,
        }),
      }),
    ),
  );
  if (
    enrollmentAttempts
      .map((response) => response.status)
      .sort((left, right) => left - right)
      .join(",") !== "201,401"
  ) {
    throw new Error("Concurrent enrollment replay was not rejected atomically");
  }

  const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
  const odsEntry = resolve(root, "apps/cli/src/index.ts");
  const selectedWorkspaceMachines = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--admin-key",
      adminKey,
      "--workspace-id",
      isolatedWorkspace.id,
      "--json",
      "machines",
      "--admin",
    ]),
  );
  if (
    selectedWorkspaceMachines.data.length !== 1 ||
    selectedWorkspaceMachines.data[0]?.id !== isolatedMachine.machineId
  ) {
    throw new Error("CLI administrator commands ignored the explicit workspace");
  }

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
    [tsxCli, odsEntry, "client", "start", "--config", configPath],
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

  const crossWorkspacePing = await fetch(
    new URL(`/v1/machines/${machine.id}/ping`, apiUrl),
    {
      method: "POST",
      headers: { authorization: `Bearer ${isolatedAgent.token}` },
    },
  );
  if (crossWorkspacePing.status !== 403) {
    throw new Error("Agent token could ping a machine from another workspace");
  }
  const crossWorkspaceSession = await fetch(new URL("/v1/sessions", apiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${isolatedAgent.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      machineId: machine.id,
      profile: "workspace",
      ttlSeconds: 120,
      capabilities: ["process.exec"],
    }),
  });
  if (crossWorkspaceSession.status !== 403) {
    throw new Error("Agent token could open a session in another workspace");
  }
  const crossWorkspaceGrant = await fetch(
    new URL("/v1/admin/agent-tokens", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-admin-key": adminKey,
        "x-odyshell-workspace-id": isolatedWorkspace.id,
      },
      body: JSON.stringify({
        name: "cross-workspace-grant",
        machineIds: [machine.id],
        capabilities: ["process.exec"],
        expiresInSeconds: 600,
      }),
    },
  );
  if (crossWorkspaceGrant.status !== 400) {
    throw new Error("Administrator could grant a machine from another workspace");
  }
  const defaultAdminMachines = await api("/v1/admin/machines", {
    headers: { "x-odyshell-admin-key": adminKey },
  });
  const isolatedAdminMachines = await api("/v1/admin/machines", {
    headers: {
      "x-odyshell-admin-key": adminKey,
      "x-odyshell-workspace-id": isolatedWorkspace.id,
    },
  });
  if (
    defaultAdminMachines.data.some((item) => item.id === isolatedMachine.machineId) ||
    isolatedAdminMachines.data.some((item) => item.id === machine.id) ||
    !isolatedAdminMachines.data.some(
      (item) => item.id === isolatedMachine.machineId,
    )
  ) {
    throw new Error("Administrator machine views crossed workspace boundaries");
  }
  const missingWorkspace = await fetch(
    new URL("/v1/admin/machines", apiUrl),
    {
      headers: {
        "x-odyshell-admin-key": adminKey,
        "x-odyshell-workspace-id": crypto.randomUUID(),
      },
    },
  );
  if (missingWorkspace.status !== 404) {
    throw new Error("Unknown administrator workspace did not fail closed");
  }
  let databaseBoundaryRejected = false;
  try {
    await compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "odyshell",
      "-d",
      "odyshell",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      [
        "insert into odyshell.sessions",
        "(workspace_id, id, machine_id, principal_id, profile, capabilities, status, expires_at)",
        `values ('${isolatedWorkspace.id}', '${crypto.randomUUID()}', '${machine.id}',`,
        "'boundary-test', 'workspace', '[\"process.exec\"]'::jsonb, 'opening', now() + interval '1 minute');",
      ].join(" "),
    ]);
  } catch {
    databaseBoundaryRejected = true;
  }
  if (!databaseBoundaryRejected) {
    throw new Error("PostgreSQL accepted a session linked across workspaces");
  }

  const adminMachines = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--admin-key",
      adminKey,
      "--json",
      "machines",
      "--admin",
    ]),
  );
  if (
    !adminMachines.data.some(
      (item) => item.id === machine.id && item.name === machine.name && item.revokedAt === null,
    )
  ) {
    throw new Error("Administrator machine list did not include the enrolled client");
  }

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
      machine.name,
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

  const idempotencyKey = crypto.randomUUID();
  const idempotentRequest = () =>
    fetch(new URL(`/v1/sessions/${session.id}/operations`, apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-agent-key": agentKey,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        action: {
          kind: "process.exec",
          program: "printf",
          args: ["idempotent"],
          cwd: ".",
          env: {},
        },
        timeoutSeconds: 10,
        maxOutputBytes: 1024,
      }),
    });
  const idempotentResponses = await Promise.all([
    idempotentRequest(),
    idempotentRequest(),
  ]);
  if (idempotentResponses.some((response) => !response.ok)) {
    throw new Error("Concurrent idempotent operation request failed");
  }
  const idempotentOperations = await Promise.all(
    idempotentResponses.map((response) => response.json()),
  );
  if (new Set(idempotentOperations.map((operation) => operation.id)).size !== 1) {
    throw new Error("Concurrent idempotent requests created multiple operations");
  }
  await waitUntil(
    () => api(`/v1/operations/${idempotentOperations[0].id}`),
    (value) => value.status === "succeeded",
    "idempotent operation",
  );

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
  const isolatedAdminAudit = await api("/v1/admin/audit?limit=200", {
    headers: {
      "x-odyshell-admin-key": adminKey,
      "x-odyshell-workspace-id": isolatedWorkspace.id,
    },
  });
  if (
    isolatedAdminAudit.data.some(
      (event) => event.principalId === scopedAgent.id,
    )
  ) {
    throw new Error("Audit events leaked across workspace boundaries");
  }
  const operationCreatedAudit = adminAudit.data.find(
    (event) =>
      event.principalId === scopedAgent.id &&
      event.action === "operation.created",
  );
  if (
    !operationCreatedAudit ||
    Object.keys(operationCreatedAudit.metadata.operation ?? {}).join(",") !== "kind"
  ) {
    throw new Error("Durable audit metadata retained operation content");
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

  const revokedMachine = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--admin-key",
      adminKey,
      "--json",
      "machine",
      "revoke",
      machine.name,
    ]),
  );
  if (
    revokedMachine.status !== "revoked" ||
    revokedMachine.id !== machine.id ||
    !revokedMachine.disconnected
  ) {
    throw new Error("Machine revocation did not disconnect the active identity");
  }
  const revokedAdminList = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--admin-key",
      adminKey,
      "--json",
      "machines",
      "--admin",
    ]),
  );
  const revokedInAdminList = revokedAdminList.data.find((item) => item.id === machine.id);
  if (!revokedInAdminList?.revokedAt || revokedInAdminList.online) {
    throw new Error("Revoked machine state was not preserved for administrator audit");
  }
  const visibleAfterRevocation = await api("/v1/machines");
  if (visibleAfterRevocation.data.some((item) => item.id === machine.id)) {
    throw new Error("Revoked machine remained visible to agents");
  }

  await compose([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "odyshell",
    "-d",
    "odyshell",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    [
      "update odyshell.operations",
      "set updated_at = now() - interval '2 hours'",
      "where status not in ('queued', 'delivered', 'running');",
      "update odyshell.sessions",
      "set updated_at = now() - interval '2 hours'",
      "where status not in ('opening', 'ready', 'closing');",
      "update odyshell.audit_events",
      "set created_at = now() - interval '31 days';",
      "insert into odyshell.enrollment_tokens",
      "(workspace_id, token_hash, expires_at, used_at)",
      "values",
      "('default', 'retention-expired-enrollment', now() - interval '2 hours', null),",
      "('default', 'retention-current-enrollment', now() + interval '1 day', null);",
      "insert into odyshell.agent_tokens",
      "(workspace_id, id, name, token_hash, machine_ids, capabilities, expires_at, revoked_at)",
      "values",
      "('default', 'retention-active-access', 'active', 'retention-active-hash', '[]'::jsonb, '[\"fs.read\"]'::jsonb, now() + interval '1 day', null),",
      "('default', 'retention-inactive-access', 'inactive', 'retention-inactive-hash', '[]'::jsonb, '[\"fs.read\"]'::jsonb, now() - interval '31 days', null),",
      "('default', 'retention-referenced-access', 'referenced', 'retention-referenced-hash', '[]'::jsonb, '[\"fs.read\"]'::jsonb, now() - interval '31 days', null);",
      "insert into odyshell.audit_events",
      "(workspace_id, id, principal_id, action, target_type, target_id, metadata)",
      "values",
      "('default', 'retention-reference-event', 'retention-referenced-access', 'agent_token.revoked', 'agent_token', 'retention-referenced-access', '{}'::jsonb);",
    ].join(" "),
  ]);
  await compose(["restart", "server"]);
  const restartedPublished = (await compose(["port", "server", "4100"]))
    .trim()
    .split(/\r?\n/)[0];
  if (!restartedPublished) throw new Error("Restarted Server port was not published");
  const restartedSeparator = restartedPublished.lastIndexOf(":");
  if (restartedSeparator <= 0) {
    throw new Error(`Could not parse restarted Server address: ${restartedPublished}`);
  }
  const restartedRawHost = restartedPublished
    .slice(0, restartedSeparator)
    .replace(/^\[|\]$/g, "");
  const restartedPort = restartedPublished.slice(restartedSeparator + 1);
  const restartedHost =
    restartedRawHost === "0.0.0.0" || restartedRawHost === "::"
      ? "127.0.0.1"
      : restartedRawHost;
  apiUrl = `http://${restartedHost.includes(":") ? `[${restartedHost}]` : restartedHost}:${restartedPort}`;
  try {
    await waitUntil(
      () => api("/health").catch(() => ({ status: "starting" })),
      (value) => value.status === "ok",
      "server restart after privacy retention setup",
    );
  } catch (error) {
    const serverLogs = await compose(["logs", "--no-color", "--tail", "100", "server"]);
    throw new Error(`${error.message}\n${serverLogs}`);
  }
  const retainedRows = (
    await compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "odyshell",
      "-d",
      "odyshell",
      "-tA",
      "-c",
      [
        "select",
        "(select count(*) from odyshell.operations",
        "where status not in ('queued', 'delivered', 'running')",
        "and updated_at < now() - interval '1 hour'),",
        "(select count(*) from odyshell.operation_events),",
        "(select count(*) from odyshell.sessions",
        "where status not in ('opening', 'ready', 'closing')",
        "and updated_at < now() - interval '1 hour'),",
        "(select count(*) from odyshell.audit_events",
        "where created_at < now() - interval '30 days'),",
        "(select count(*) from odyshell.enrollment_tokens",
        "where token_hash = 'retention-expired-enrollment'),",
        "(select count(*) from odyshell.enrollment_tokens",
        "where token_hash = 'retention-current-enrollment'),",
        "(select count(*) from odyshell.agent_tokens",
        "where id = 'retention-active-access'),",
        "(select count(*) from odyshell.agent_tokens",
        "where id = 'retention-inactive-access'),",
        "(select count(*) from odyshell.agent_tokens",
        "where id = 'retention-referenced-access');",
      ].join(" "),
    ])
  ).trim();
  if (retainedRows !== "0|0|0|0|0|1|1|0|1") {
    throw new Error(`Privacy retention left expired rows: ${retainedRows}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        machineId: machine.id,
        sessionId: session.id,
        checks: {
          outboundClient: true,
          organizationBoundary: true,
          organizationScopedWorkspaceSlugs: true,
          workspaceIsolation: true,
          crossWorkspaceAccessDenied: true,
          databaseWorkspaceBoundary: true,
          workspaceAuditIsolation: true,
          ed25519Authentication: true,
          runtimeMetadata: `${machine.runtime.hostPlatform}/${machine.runtime.architecture}`,
          odsCli: true,
          odsWorkspaceSelection: true,
          odsPing: true,
          scopedAgentToken: true,
          agentAccessListed: true,
          agentAccessRevoked: true,
          sessionBoundedByToken: true,
          capabilityScopeDenied: true,
          clientPolicyDenied: true,
          auditTrail: true,
          administratorAudit: true,
          contentMinimalAudit: true,
          sandboxPolicy: true,
          readOnlyWorkspaceByDefault: true,
          ipcIsolated: true,
          sandboxedExec: execResult.output.trim(),
          filesystemRoundTrip: readResult.output,
          networkBlocked: networkResult.status === "failed",
          traversalRejected: true,
          enrollmentReplayRejected: true,
          idempotencyReplaySafe: true,
          privacyRetention: true,
          credentialRetention: true,
          cancellation: true,
          sessionDestroyed: true,
          administratorMachineList: true,
          machineNamesInAgentScopes: true,
          machineAccessRevoked: true,
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
