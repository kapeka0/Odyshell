import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const expectedProtocolVersion = 4;
let apiUrl;
const agentKey = process.env.ODYSHELL_AGENT_KEY ?? "dev-agent-key";
const adminKey = process.env.ODYSHELL_ADMIN_KEY ?? "dev-admin-key";
const webKey = "e2e-web-key-at-least-thirty-two-characters";
const composeProject = `odyshell-e2e-${process.pid}`;
const composeEnvironment = {
  ...process.env,
  ODYSHELL_BIND_ADDRESS: "127.0.0.1",
  ODYSHELL_SERVER_PORT: "0",
  ODYSHELL_POSTGRES_PORT: "0",
  ODYSHELL_AGENT_KEY: agentKey,
  ODYSHELL_ADMIN_KEY: adminKey,
  ODYSHELL_ALLOW_DEV_CREDENTIALS: "true",
  ODYSHELL_WEB_KEY: webKey,
  ODYSHELL_WEB_URL: "http://127.0.0.1:3000",
  ODYSHELL_EVENT_SINK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
};
const configDirectory = resolve(root, `.odyshell/e2e/${process.pid}`);
const configPath = resolve(configDirectory, "client.json");
process.env.ODS_CONFIG_FILE = resolve(configDirectory, "cli.json");
const workspace = resolve(root, `tmp/e2e-workspace-${process.pid}`);
let client;
let e2eMachineId;
const allCapabilities = [
  "process.exec",
  "host.shell",
  "fs.stat",
  "fs.list",
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.remove",
];
const clientCapabilities = allCapabilities.filter(
  (capability) => capability !== "host.shell",
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
      authorization: `Bearer ${agentKey}`,
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function credentialApi(token, path, options = {}) {
  return await api(path, {
    ...options,
    headers: {
      ...options.headers,
      authorization: `Bearer ${token}`,
    },
  });
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

async function supersedeMachineConnection(config) {
  const url = new URL("/v1/connect", apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  const observedCancellations = new Set();
  const cancellationWaiters = new Map();
  await new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolvePromise();
    };
    const timeout = setTimeout(
      () => finish(new Error("Timed out superseding the E2E machine connection")),
      10_000,
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "challenge") {
        const signature = sign(
          null,
          Buffer.from(`odyshell:${message.connectionId}:${message.nonce}`),
          config.privateKeyPem,
        ).toString("base64url");
        socket.send(
          JSON.stringify({
            type: "authenticate",
            machineId: config.machineId,
            protocolVersion: expectedProtocolVersion,
            signature,
          }),
        );
      } else if (message.type === "authenticated") {
        finish();
      } else if (message.type === "operation.cancel") {
        observedCancellations.add(message.operationId);
        cancellationWaiters.get(message.operationId)?.();
      } else if (message.type === "error") {
        finish(new Error(`${message.code}: ${message.message}`));
      }
    });
    socket.addEventListener("error", () =>
      finish(new Error("Replacement E2E machine socket failed")),
    );
    socket.addEventListener("close", () =>
      finish(new Error("Replacement E2E machine socket closed before authentication")),
    );
  });
  return {
    socket,
    waitForCancellation(operationId) {
      if (observedCancellations.has(operationId)) return Promise.resolve();
      return new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => {
          cancellationWaiters.delete(operationId);
          reject(new Error(`Timed out waiting for cancellation ${operationId}`));
        }, 10_000);
        cancellationWaiters.set(operationId, () => {
          clearTimeout(timeout);
          cancellationWaiters.delete(operationId);
          resolvePromise();
        });
      });
    },
  };
}

async function operation(
  sessionId,
  action,
  expectedStatus = "succeeded",
  token = agentKey,
) {
  const created = await credentialApi(token, `/v1/sessions/${sessionId}/operations`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ action, timeoutSeconds: 10, maxOutputBytes: 1024 * 1024 }),
  });
  const completed = await waitUntil(
    () => credentialApi(token, `/v1/operations/${created.id}`),
    (value) =>
      !["queued", "delivered", "running", "cancellation_requested"].includes(
        value.status,
      ),
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

  const deniedSinkResponse = await fetch(
    new URL("/v1/admin/event-sink", apiUrl),
    {
      method: "PUT",
      headers: {
        "x-odyshell-admin-key": adminKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        endpoint: "https://169.254.169.254/latest/meta-data",
        detailLevel: "diagnostic",
        signingSecret: "e2e-signing-secret-at-least-32-characters",
      }),
    },
  );
  const deniedSink = await deniedSinkResponse.json();
  if (
    deniedSinkResponse.status !== 400 ||
    deniedSink.error !== "event_sink_destination_denied" ||
    JSON.stringify(deniedSink).includes("e2e-signing-secret")
  ) {
    throw new Error("Event Sink SSRF boundary failed");
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

  const replacementEnrollment = await api("/v1/admin/enrollment-tokens", {
    method: "POST",
    headers: {
      "x-odyshell-admin-key": adminKey,
      "x-odyshell-workspace-id": isolatedWorkspace.id,
    },
    body: JSON.stringify({ expiresInSeconds: 600 }),
  });
  const replacementKey = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const activeReplacement = await fetch(new URL("/v1/clients/enroll", apiUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: replacementEnrollment.token,
      name: "replacement-denied",
      publicKey: replacementKey,
      previousMachineId: isolatedMachine.machineId,
    }),
  });
  const activeReplacementBody = await activeReplacement.json();
  if (
    activeReplacement.status !== 409 ||
    activeReplacementBody.error !== "previous_machine_still_active"
  ) {
    throw new Error("An active Client identity could be replaced without revocation");
  }
  await api(`/v1/admin/machines/${isolatedMachine.machineId}`, {
    method: "DELETE",
    headers: {
      "x-odyshell-admin-key": adminKey,
      "x-odyshell-workspace-id": isolatedWorkspace.id,
    },
  });
  const replacedMachine = await api("/v1/clients/enroll", {
    method: "POST",
    body: JSON.stringify({
      token: replacementEnrollment.token,
      name: "isolated-machine",
      publicKey: replacementKey,
      previousMachineId: isolatedMachine.machineId,
    }),
  });
  if (
    replacedMachine.workspaceId !== isolatedWorkspace.id ||
    replacedMachine.machineId === isolatedMachine.machineId
  ) {
    throw new Error("A revoked Client identity was not safely re-enrolled");
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
    !selectedWorkspaceMachines.data.some(
      (item) => item.id === replacedMachine.machineId && item.status !== "revoked",
    ) ||
    !selectedWorkspaceMachines.data.some(
      (item) => item.id === isolatedMachine.machineId && item.revokedAt,
    )
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
        "--mount-source",
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
  const enrolledClientConfig = JSON.parse(await readFile(configPath, "utf8"));
  if (
    enrolledClientConfig.workspaceId !== "default" ||
    enrolledClientConfig.machineId !== enrolled.machineId
  ) {
    throw new Error("Client Profile did not retain its Workspace and machine identity");
  }
  const dockerWorkspaceProfile = enrolledClientConfig.profiles?.workspace;
  if (!dockerWorkspaceProfile || dockerWorkspaceProfile.runner !== "docker") {
    throw new Error("E2E enrollment did not create its Docker workspace profile");
  }
  enrolledClientConfig.profiles.host = {
    runner: "host",
    maxSessionTtlSeconds: dockerWorkspaceProfile.maxSessionTtlSeconds,
    maxConcurrentSessions: dockerWorkspaceProfile.maxConcurrentSessions,
    maxConcurrentOperations: dockerWorkspaceProfile.maxConcurrentOperations,
    maxOperationTimeoutSeconds: dockerWorkspaceProfile.maxOperationTimeoutSeconds,
    maxOutputBytes: dockerWorkspaceProfile.maxOutputBytes,
    capabilities: ["host.shell"],
  };
  await writeFile(
    configPath,
    `${JSON.stringify(enrolledClientConfig, null, 2)}\n`,
    { mode: 0o600 },
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
      value.data.some(
        (machine) =>
          machine.id === enrolled.machineId &&
          machine.online &&
          machine.runtime?.hostPlatform,
      ),
    "client authentication",
  );
  const machine = machines.data.find(
    (item) => item.id === enrolled.machineId && item.online,
  );
  if (!machine) throw new Error("Enrolled client did not come online");
  if (
    !["linux", "macos", "windows"].includes(machine.runtime?.hostPlatform) ||
    !machine.runtime?.architecture ||
    machine.runtime?.containerOs !== "linux" ||
    machine.runtime?.protocolVersion !== expectedProtocolVersion ||
    !/^\d+\.\d+\.\d+$/u.test(machine.runtime?.clientVersion ?? "") ||
    !machine.runtime?.supportedCapabilities?.includes("fs.read") ||
    !machine.runtime?.supportedCapabilities?.includes("host.shell") ||
    !machine.runtime?.profiles?.some(
      (profile) =>
        profile.name === "host" &&
        profile.runner === "host" &&
        profile.capabilities?.includes("host.shell"),
    ) ||
    machine.compatible !== true ||
    machine.upgradeRequired !== false
  ) {
    throw new Error("Client runtime metadata was not reported");
  }
  e2eMachineId = machine.id;

  await writeFile(
    resolve(workspace, "approved.txt"),
    "approved session read",
    "utf8",
  );
  const cliToken = `ods_cli_e2e_${crypto.randomUUID()}`;
  const cliTokenHash = createHash("sha256").update(cliToken).digest("hex");
  const cliUserId = `e2e-user-${crypto.randomUUID()}`;
  const unrelatedCliToken = `ods_cli_e2e_${crypto.randomUUID()}`;
  const unrelatedCliTokenHash = createHash("sha256")
    .update(unrelatedCliToken)
    .digest("hex");
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
      "update odyshell.organizations",
      "set external_id = 'e2e-identity-organization', plan = 'scale'",
      "where id = 'default';",
      "insert into odyshell.cli_tokens",
      "(workspace_id, id, user_id, token_hash, expires_at)",
      `values ('default', '${crypto.randomUUID()}', '${cliUserId}', '${cliTokenHash}', now() + interval '1 hour');`,
      "insert into odyshell.cli_tokens",
      "(workspace_id, id, user_id, token_hash, expires_at)",
      `values ('default', '${crypto.randomUUID()}', 'unrelated-${cliUserId}', '${unrelatedCliTokenHash}', now() + interval '1 hour');`,
    ].join(" "),
  ]);
  const memberSinkMutation = await fetch(
    new URL("/v1/admin/event-sink", apiUrl),
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        endpoint: "https://events.example/odyshell",
        detailLevel: "privacy-minimal",
        signingSecret: "member-must-not-configure-this-secret",
      }),
    },
  );
  const memberSinkMutationBody = await memberSinkMutation.json();
  if (
    memberSinkMutation.status !== 401 ||
    memberSinkMutationBody.error !== "invalid_admin_key" ||
    JSON.stringify(memberSinkMutationBody).includes("member-must-not")
  ) {
    throw new Error("A Workspace member configured an administrator Event Sink");
  }
  const approvedAgentId = crypto.randomUUID();
  const requestResponse = await fetch(
    new URL("/v1/agent-session-requests", apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: approvedAgentId,
        agentName: "E2E MCP Agent",
        title: "Read approved test file",
        purpose: "Read the approved test file",
        scopes: [
          {
            machineId: machine.id,
            profile: "workspace",
            capabilities: ["fs.read", "process.exec"],
            restrictions: {
              filesystem: {
                paths: [
                  {
                    path: "approved.txt",
                    includeDescendants: false,
                  },
                ],
              },
              process: {
                programs: [
                  {
                    program: "sleep",
                    args: ["30"],
                    cwd: {
                      path: ".",
                      includeDescendants: false,
                    },
                  },
                ],
              },
            },
          },
        ],
        durationSeconds: 600,
      }),
    },
  );
  const requestedSession = await requestResponse.json();
  if (requestResponse.status !== 201 || !requestedSession.approvalUrl) {
    throw new Error(
      `Session request failed: ${requestResponse.status} ${JSON.stringify(requestedSession)}`,
    );
  }
  const approvalCode = new URL(requestedSession.approvalUrl).searchParams.get(
    "request",
  );
  if (!approvalCode) throw new Error("Session approval URL omitted its request");

  const wrongWorkspaceApproval = await fetch(
    new URL("/v1/internal/cloud/session-requests/approve", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        userId: "other-user",
        organization: {
          externalId: "other-identity-organization",
          slug: "other-organization",
          name: "Other organization",
        },
        requestId: approvalCode,
      }),
    },
  );
  if (wrongWorkspaceApproval.status !== 404) {
    throw new Error("A different workspace could approve the Session request");
  }

  const approvalBody = {
    userId: cliUserId,
    organization: {
      externalId: "e2e-identity-organization",
      slug: "default",
      name: "Default organization",
    },
    requestId: approvalCode,
  };
  const agentDeviceStartResponse = await fetch(
    new URL("/v1/auth/agent/device", apiUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentName: "E2E Independent Agent" }),
    },
  );
  const agentDevice = await agentDeviceStartResponse.json();
  if (
    agentDeviceStartResponse.status !== 201 ||
    !agentDevice.deviceCode ||
    !agentDevice.userCode
  ) {
    throw new Error("Independent Agent device authorization did not start");
  }
  const pendingAgentExchange = await fetch(
    new URL("/v1/auth/agent/device/token", apiUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: agentDevice.deviceCode }),
    },
  );
  if (pendingAgentExchange.status !== 400) {
    throw new Error("Pending Agent device authorization was not held");
  }
  const agentApprovalBody = {
    userId: cliUserId,
    organization: approvalBody.organization,
    userCode: agentDevice.userCode,
  };
  const inspectAgentDevice = await fetch(
    new URL("/v1/internal/cloud/agent-device/inspect", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify(agentApprovalBody),
    },
  );
  if (
    inspectAgentDevice.status !== 200 ||
    (await inspectAgentDevice.json()).agentName !== "E2E Independent Agent"
  ) {
    throw new Error("Agent registration approval omitted the proposed identity");
  }
  const approveAgentDevice = () =>
    fetch(new URL("/v1/internal/cloud/agent-device/approve", apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify(agentApprovalBody),
    });
  const approvedAgentDevice = await approveAgentDevice();
  if (approvedAgentDevice.status !== 200) {
    throw new Error("Independent Agent registration was not approved");
  }
  if ((await approveAgentDevice()).status !== 409) {
    throw new Error("Agent registration approval replay was not rejected");
  }
  const agentExchangeResponse = await fetch(
    new URL("/v1/auth/agent/device/token", apiUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: agentDevice.deviceCode }),
    },
  );
  const agentCredential = await agentExchangeResponse.json();
  if (
    agentExchangeResponse.status !== 200 ||
    !agentCredential.accessToken ||
    !agentCredential.agentId
  ) {
    throw new Error("Agent Credential was not issued");
  }
  const replayAgentExchange = await fetch(
    new URL("/v1/auth/agent/device/token", apiUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: agentDevice.deviceCode }),
    },
  );
  if (replayAgentExchange.status !== 409) {
    throw new Error("Agent device code replay was not rejected");
  }
  const directAgentOperation = await fetch(new URL("/v1/sessions", apiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentCredential.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      machineId: machine.id,
      profile: "workspace",
      ttlSeconds: 600,
      capabilities: ["fs.read"],
    }),
  });
  if (directAgentOperation.status !== 410) {
    throw new Error("Legacy Session creation remained available to Agent Credentials");
  }
  const rotationResponse = await fetch(
    new URL("/v1/agent-credentials/rotate", apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentCredential.accessToken}`,
      },
    },
  );
  const rotatedAgentCredential = await rotationResponse.json();
  if (
    rotationResponse.status !== 200 ||
    !rotatedAgentCredential.accessToken ||
    rotatedAgentCredential.overlapSeconds !== 600
  ) {
    throw new Error("Agent Credential rotation failed");
  }
  const repeatedRotationResponse = await fetch(
    new URL("/v1/agent-credentials/rotate", apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentCredential.accessToken}`,
      },
    },
  );
  if (repeatedRotationResponse.status !== 401) {
    throw new Error("A retiring Agent Credential extended its overlap");
  }
  const policyScope = {
    machineId: machine.id,
    profile: "workspace",
    capabilities: ["fs.read"],
    restrictions: {
      filesystem: {
        paths: [{ path: "approved.txt", includeDescendants: false }],
      },
    },
  };
  const policyProposalResponse = await fetch(
    new URL("/v1/agent-policies", apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scopes: [policyScope],
        maxSessionSeconds: 600,
        validForSeconds: 24 * 60 * 60,
      }),
    },
  );
  const policyProposal = await policyProposalResponse.json();
  if (
    policyProposalResponse.status !== 201 ||
    policyProposal.status !== "proposed" ||
    !policyProposal.approvalUrl
  ) {
    throw new Error("Agent autoapproval policy was not proposed");
  }
  const policyApprovalCode = new URL(
    policyProposal.approvalUrl,
  ).searchParams.get("code");
  if (!policyApprovalCode) {
    throw new Error("Policy approval URL omitted its code");
  }
  const policyApprovalBody = {
    userId: cliUserId,
    organization: approvalBody.organization,
    approvalCode: policyApprovalCode,
  };
  const policyInspection = await fetch(
    new URL("/v1/internal/cloud/agent-policies/inspect", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify(policyApprovalBody),
    },
  );
  if (
    policyInspection.status !== 200 ||
    (await policyInspection.json()).version !== 1
  ) {
    throw new Error("Policy approval did not show its immutable version");
  }
  const approvePolicy = () =>
    fetch(new URL("/v1/internal/cloud/agent-policies/approve", apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify(policyApprovalBody),
    });
  if ((await approvePolicy()).status !== 200) {
    throw new Error("Agent autoapproval policy was not approved");
  }
  if ((await approvePolicy()).status !== 409) {
    throw new Error("Policy approval replay was not rejected");
  }
  const requestWithPolicy = async (scopes, purpose) => {
    const response = await fetch(
      new URL("/v1/agent-session-requests", apiUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentId: agentCredential.agentId,
          agentName: agentCredential.agentName,
          title: purpose,
          purpose,
          scopes,
          durationSeconds: 600,
        }),
      },
    );
    return { response, body: await response.json() };
  };
  const autoapproved = await requestWithPolicy(
    [policyScope],
    "Verify policy autoapproval",
  );
  if (
    autoapproved.response.status !== 201 ||
    autoapproved.body.status !== "approved" ||
    autoapproved.body.approvalUrl ||
    autoapproved.body.autoapprovalPolicy?.id !== policyProposal.id
  ) {
    throw new Error("In-policy Session request was not autoapproved");
  }
  const widened = await requestWithPolicy(
    [{ ...policyScope, capabilities: ["fs.read", "fs.write"] }],
    "Verify policy widening denial",
  );
  if (
    widened.response.status !== 201 ||
    widened.body.status !== "pending" ||
    !widened.body.approvalUrl
  ) {
    throw new Error("Out-of-policy Session request did not remain pending");
  }
  const widenedApprovalCode = new URL(
    widened.body.approvalUrl,
  ).searchParams.get("request");
  if (!widenedApprovalCode) {
    throw new Error("Out-of-policy Session approval URL omitted its code");
  }
  const denyWidenedResponse = await fetch(
    new URL("/v1/internal/cloud/session-requests/deny", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...approvalBody,
        requestId: widenedApprovalCode,
      }),
    },
  );
  if (denyWidenedResponse.status !== 200) {
    throw new Error("Pending Session request could not be denied");
  }
  const deniedClaimResponse = await fetch(
    new URL(
      `/v1/agent-session-requests/${widened.body.id}/claim`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: agentCredential.agentId }),
    },
  );
  const deniedClaim = await deniedClaimResponse.json();
  if (
    deniedClaimResponse.status !== 403 ||
    deniedClaim.error !== "denied"
  ) {
    throw new Error("Denied Session request could still be claimed");
  }
  const autoClaimResponse = await fetch(
    new URL(
      `/v1/agent-session-requests/${autoapproved.body.id}/claim`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: agentCredential.agentId }),
    },
  );
  const autoClaim = await autoClaimResponse.json();
  if (autoClaimResponse.status !== 201 || !autoClaim.sessionId) {
    throw new Error("Autoapproved Session could not be claimed");
  }
  const policyBinding = (
    await compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "odyshell",
      "-d",
      "odyshell",
      "-At",
      "-c",
      `select autoapproval_policy_id || ':' || autoapproval_policy_version from odyshell.agent_sessions where id = '${autoClaim.sessionId}';`,
    ])
  ).trim();
  if (policyBinding !== `${policyProposal.id}:1`) {
    throw new Error("Claimed Session lost its approving policy version");
  }
  await fetch(
    new URL(`/v1/agent-sessions/${autoClaim.sessionId}/cancel`, apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: agentCredential.agentId }),
    },
  );
  const revokePolicy = await fetch(
    new URL(`/v1/agent-policies/${policyProposal.id}/revoke`, apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
      },
    },
  );
  if (revokePolicy.status !== 200) {
    throw new Error("Agent could not revoke its own autoapproval policy");
  }
  const afterRevoke = await requestWithPolicy(
    [policyScope],
    "Verify revoked policy denial",
  );
  if (
    afterRevoke.response.status !== 201 ||
    afterRevoke.body.status !== "pending"
  ) {
    throw new Error("Revoked policy continued autoapproving Sessions");
  }
  const cloudIdentity = {
    userId: cliUserId,
    userName: "E2E Member",
    organization: approvalBody.organization,
  };
  const defaultSettingsContextResponse = await fetch(
    new URL("/v1/internal/cloud/context", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify(cloudIdentity),
    },
  );
  const defaultSettingsContext = await defaultSettingsContextResponse.json();
  if (
    defaultSettingsContext.workspace?.name !== "E2E's Workspace" ||
    defaultSettingsContext.workspace?.loggingLevel !== "privacy-minimal" ||
    !defaultSettingsContext.workspace?.avatarSeed ||
    defaultSettingsContext.userPreferences?.timeZone !== "System"
  ) {
    throw new Error("Workspace or user settings did not start fail-safe");
  }
  const userSettingsResponse = await fetch(
    new URL("/v1/internal/cloud/user-settings/update", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({ ...cloudIdentity, timeZone: "UTC" }),
    },
  );
  const workspaceDetailsResponse = await fetch(
    new URL("/v1/internal/cloud/workspace/settings/update", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...cloudIdentity,
        section: "details",
        name: "E2E workspace",
        avatarSeed: "e2e-avatar-seed",
      }),
    },
  );
  const workspaceLoggingResponse = await fetch(
    new URL("/v1/internal/cloud/workspace/settings/update", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...cloudIdentity,
        section: "logging",
        loggingLevel: "operational",
      }),
    },
  );
  if (
    userSettingsResponse.status !== 200 ||
    workspaceDetailsResponse.status !== 200 ||
    workspaceLoggingResponse.status !== 200
  ) {
    throw new Error("User or Workspace settings could not be updated");
  }
  const notificationContextResponse = await fetch(
    new URL("/v1/internal/cloud/context", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify(cloudIdentity),
    },
  );
  const notificationContext = await notificationContextResponse.json();
  if (
    notificationContext.workspace?.name !== "E2E workspace" ||
    notificationContext.workspace?.avatarSeed !== "e2e-avatar-seed" ||
    notificationContext.workspace?.loggingLevel !== "operational" ||
    notificationContext.userPreferences?.timeZone !== "UTC"
  ) {
    throw new Error("User or Workspace settings were not persisted");
  }
  const sessionNotification = notificationContext.notifications?.find(
    (notification) =>
      notification.kind === "session.requested" &&
      notification.href.includes(afterRevoke.body.id),
  );
  if (!sessionNotification || sessionNotification.readAt !== null) {
    throw new Error("A pending Session did not notify its responsible member");
  }
  const crossMemberRead = await fetch(
    new URL("/v1/internal/cloud/notifications/read", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...cloudIdentity,
        userId: "unrelated-member",
        notificationId: sessionNotification.id,
      }),
    },
  );
  if (crossMemberRead.status !== 404) {
    throw new Error("A notification could be read by another Workspace member");
  }
  const ownNotificationRead = await fetch(
    new URL("/v1/internal/cloud/notifications/read", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...cloudIdentity,
        notificationId: sessionNotification.id,
      }),
    },
  );
  if (ownNotificationRead.status !== 200) {
    throw new Error("The responsible member could not mark a notification read");
  }
  const enrollmentNotificationResponse = await fetch(
    new URL("/v1/internal/cloud/context", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({ ...cloudIdentity, userId: "admin" }),
    },
  );
  const enrollmentNotificationContext = await enrollmentNotificationResponse.json();
  if (
    !enrollmentNotificationContext.notifications?.some(
      (notification) => notification.kind === "machine.enrolled",
    )
  ) {
    throw new Error("Machine enrollment did not notify the token creator");
  }
  const independentRequestResponse = await fetch(
    new URL("/v1/agent-session-requests", apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: agentCredential.agentId,
        agentName: agentCredential.agentName,
        title: "Verify Independent Agent identity",
        purpose: "Verify Independent Agent identity",
        scopes: [
          {
            machineId: machine.id,
            profile: "workspace",
            capabilities: ["fs.read"],
            restrictions: {
              filesystem: {
                paths: [
                  { path: "approved.txt", includeDescendants: false },
                ],
              },
            },
          },
        ],
        durationSeconds: 600,
      }),
    },
  );
  const independentRequest = await independentRequestResponse.json();
  if (independentRequestResponse.status !== 201) {
    throw new Error("Independent Agent could not request a Session");
  }
  const loggingSnapshot = (
    await compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "odyshell",
      "-d",
      "odyshell",
      "-tAc",
      `select logging_level from odyshell.agent_session_requests where id = '${independentRequest.id}';`,
    ])
  ).trim();
  if (loggingSnapshot !== "operational") {
    throw new Error("A Session request did not snapshot Workspace logging");
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
    "-c",
    `update odyshell.agent_credentials set retiring_at = now() - interval '1 second' where id = '${agentCredential.credentialId}';`,
  ]);
  const retiredStatus = await fetch(
    new URL(
      `/v1/agent-session-requests/${independentRequest.id}/status`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: agentCredential.agentId }),
    },
  );
  if (retiredStatus.status !== 401) {
    throw new Error("Retired Agent Credential remained valid after overlap");
  }
  const rotatedStatus = await fetch(
    new URL(
      `/v1/agent-session-requests/${independentRequest.id}/status`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: agentCredential.agentId }),
    },
  );
  if (rotatedStatus.status !== 200) {
    throw new Error("Rotated Agent Credential could not inspect its request");
  }

  const proposeDelegation = async () => {
    const response = await fetch(new URL("/v1/agent-policies", apiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "delegation",
        scopes: [policyScope],
        maxSessionSeconds: 600,
        maxManagedAgents: 2,
        validForSeconds: 24 * 60 * 60,
      }),
    });
    const policy = await response.json();
    if (response.status !== 201 || !policy.approvalUrl) {
      throw new Error("Delegation Policy was not proposed");
    }
    const code = new URL(policy.approvalUrl).searchParams.get("code");
    if (!code) throw new Error("Delegation Policy omitted its approval code");
    const approvalResponse = await fetch(
      new URL("/v1/internal/cloud/agent-policies/approve", apiUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-odyshell-web-key": webKey,
        },
        body: JSON.stringify({
          userId: cliUserId,
          organization: approvalBody.organization,
          approvalCode: code,
        }),
      },
    );
    if (approvalResponse.status !== 200) {
      throw new Error("Delegation Policy was not approved");
    }
    return policy;
  };
  const createManagedAgent = async (name, scopes = [policyScope]) => {
    const response = await fetch(new URL("/v1/managed-agents", apiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name,
        scopes,
        maxSessionSeconds: 600,
        validForSeconds: 60 * 60,
      }),
    });
    return { response, body: await response.json() };
  };
  const requestManagedSession = async (managedAgent, runId) => {
    const response = await fetch(
      new URL("/v1/agent-session-requests", apiUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentId: managedAgent.id,
          agentName: managedAgent.name,
          title: "Verify Managed Agent delegation",
          purpose: "Verify Managed Agent delegation",
          scopes: [policyScope],
          durationSeconds: 600,
          runId,
        }),
      },
    );
    return { response, body: await response.json() };
  };

  const delegationPolicy = await proposeDelegation();
  const managed = await createManagedAgent("E2E Managed Agent");
  if (
    managed.response.status !== 201 ||
    managed.body.kind !== "managed" ||
    managed.body.parentAgentId !== agentCredential.agentId ||
    managed.body.accessToken
  ) {
    throw new Error("Managed Agent identity was not safely derived");
  }
  const widenedManaged = await createManagedAgent("Widened Managed Agent", [
    { ...policyScope, capabilities: ["fs.read", "fs.write"] },
  ]);
  if (widenedManaged.response.status !== 403) {
    throw new Error("Managed Agent exceeded its Delegation Policy");
  }
  const managedRunId = `e2e-run-${crypto.randomUUID()}`;
  const managedRequest = await requestManagedSession(
    managed.body,
    managedRunId,
  );
  if (
    managedRequest.response.status !== 201 ||
    managedRequest.body.status !== "approved"
  ) {
    throw new Error("Managed Agent Session was not derived from its Policy");
  }
  const managedClaimResponse = await fetch(
    new URL(
      `/v1/agent-session-requests/${managedRequest.body.id}/claim`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: managed.body.id }),
    },
  );
  const managedClaim = await managedClaimResponse.json();
  if (managedClaimResponse.status !== 201 || !managedClaim.sessionToken) {
    throw new Error("Managed Agent Session could not be claimed");
  }
  const managedTimelineResponse = await fetch(
    new URL("/v1/internal/cloud/sessions/inspect", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        userId: cliUserId,
        organization: approvalBody.organization,
        sessionId: managedClaim.sessionId,
      }),
    },
  );
  const managedTimeline = await managedTimelineResponse.json();
  const requestedEvent = managedTimeline.timeline?.find(
    (event) => event.eventType === "session.requested",
  );
  if (
    managedTimelineResponse.status !== 200 ||
    managedTimeline.session.agentId !== managed.body.id ||
    managedTimeline.session.requestedByAgentId !== agentCredential.agentId ||
    managedTimeline.session.runId !== managedRunId ||
    requestedEvent?.metadata?.executorAgentId !== managed.body.id ||
    requestedEvent?.metadata?.requesterAgentId !== agentCredential.agentId
  ) {
    throw new Error("Managed Agent Session attribution was incomplete");
  }
  const pauseDelegation = await fetch(
    new URL(`/v1/agent-policies/${delegationPolicy.id}/pause`, apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
      },
    },
  );
  if (pauseDelegation.status !== 200) {
    throw new Error("Delegation Policy could not be paused");
  }
  const afterDelegationPause = await requestManagedSession(
    managed.body,
    `e2e-run-${crypto.randomUUID()}`,
  );
  if (afterDelegationPause.response.status !== 403) {
    throw new Error("Paused Delegation Policy still authorized new Sessions");
  }
  const disableManaged = () =>
    fetch(new URL(`/v1/managed-agents/${managed.body.id}/disable`, apiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
      },
    });
  const disabledManaged = await disableManaged();
  if (
    disabledManaged.status !== 200 ||
    (await disabledManaged.json()).terminatedSessions !== 1
  ) {
    throw new Error("Managed Agent disable did not terminate its Session");
  }
  if ((await disableManaged()).status !== 200) {
    throw new Error("Managed Agent disable was not idempotent");
  }
  const revokedManagedCredential = await fetch(
    new URL(`/v1/sessions/${managedClaim.sessionId}`, apiUrl),
    {
      headers: {
        authorization: `Bearer ${managedClaim.sessionToken}`,
      },
    },
  );
  if (revokedManagedCredential.status !== 401) {
    throw new Error("Managed Agent Session Credential survived disable");
  }
  const crossManagerDelete = await fetch(
    new URL(`/v1/managed-agents/${crypto.randomUUID()}`, apiUrl),
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
      },
    },
  );
  if (crossManagerDelete.status !== 404) {
    throw new Error("Managed Agent lookup escaped its parent boundary");
  }

  await proposeDelegation();
  const cascadeManaged = await createManagedAgent("E2E Cascade Agent");
  const cascadeRequest = await requestManagedSession(
    cascadeManaged.body,
    `e2e-run-${crypto.randomUUID()}`,
  );
  const cascadeClaimResponse = await fetch(
    new URL(
      `/v1/agent-session-requests/${cascadeRequest.body.id}/claim`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: cascadeManaged.body.id }),
    },
  );
  const cascadeClaim = await cascadeClaimResponse.json();
  if (
    cascadeManaged.response.status !== 201 ||
    cascadeRequest.response.status !== 201 ||
    cascadeRequest.body.status !== "approved" ||
    cascadeClaimResponse.status !== 201
  ) {
    throw new Error("Managed Agent cascade fixture could not be created");
  }
  const revokeHierarchy = await fetch(
    new URL("/v1/agent-credentials/revoke", apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
      },
    },
  );
  const revokedHierarchy = await revokeHierarchy.json();
  if (
    revokeHierarchy.status !== 200 ||
    revokedHierarchy.disabledManagedAgents < 2 ||
    revokedHierarchy.terminatedSessions !== 1
  ) {
    throw new Error("Manager revocation did not cascade through delegation");
  }
  const cascadeCredential = await fetch(
    new URL(`/v1/sessions/${cascadeClaim.sessionId}`, apiUrl),
    {
      headers: { authorization: `Bearer ${cascadeClaim.sessionToken}` },
    },
  );
  if (cascadeCredential.status !== 401) {
    throw new Error("Manager revocation left a derived Session active");
  }

  const approval = await fetch(
    new URL("/v1/internal/cloud/session-requests/approve", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify(approvalBody),
    },
  );
  if (approval.status !== 200) {
    throw new Error(
      `Session approval failed: ${approval.status} ${await approval.text()}`,
    );
  }
  const approvalReplay = await fetch(
    new URL("/v1/internal/cloud/session-requests/approve", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify(approvalBody),
    },
  );
  if (approvalReplay.status !== 409) {
    throw new Error("Session approval code replay was not rejected");
  }

  const claimResponse = await fetch(
    new URL(
      `/v1/agent-session-requests/${requestedSession.id}/claim`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: approvedAgentId }),
    },
  );
  const claimedSession = await claimResponse.json();
  if (claimResponse.status !== 201 || !claimedSession.sessionToken) {
    throw new Error(
      `Session claim failed: ${claimResponse.status} ${JSON.stringify(claimedSession)}`,
    );
  }
  const humanSessionListResponse = await fetch(
    new URL("/v1/agent-sessions", apiUrl),
    { headers: { authorization: `Bearer ${cliToken}` } },
  );
  const humanSessionList = await humanSessionListResponse.json();
  if (
    humanSessionListResponse.status !== 200 ||
    !humanSessionList.data?.some(
      (session) => session.id === claimedSession.sessionId,
    )
  ) {
    throw new Error("The requesting human could not list its canonical Session");
  }
  const unrelatedSessionListResponse = await fetch(
    new URL("/v1/agent-sessions", apiUrl),
    {
      headers: {
        authorization: `Bearer ${unrelatedCliToken}`,
      },
    },
  );
  const unrelatedSessionList = await unrelatedSessionListResponse.json();
  if (
    unrelatedSessionListResponse.status !== 200 ||
    unrelatedSessionList.data?.some(
      (session) => session.id === claimedSession.sessionId,
    )
  ) {
    throw new Error("An unrelated human could observe another human's Session");
  }
  const claimReplay = await fetch(
    new URL(
      `/v1/agent-session-requests/${requestedSession.id}/claim`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: approvedAgentId }),
    },
  );
  if (claimReplay.status !== 409) {
    throw new Error("Session Credential could be claimed more than once");
  }

  await waitUntil(
    async () => {
      const response = await fetch(
        new URL(`/v1/sessions/${claimedSession.sessionId}`, apiUrl),
        {
          headers: {
            authorization: `Bearer ${claimedSession.sessionToken}`,
          },
        },
      );
      return response.json();
    },
    (value) => value.status === "ready" || value.status === "failed",
    "approved Session target",
  );
  await compose([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "odyshell",
    "-d",
    "odyshell",
    "-c",
    `update odyshell.agent_session_targets set status = 'rejected' where session_id = '${claimedSession.sessionId}'; update odyshell.sessions set status = 'failed', error = 'capability_denied' where id in (select runtime_session_id from odyshell.agent_session_targets where session_id = '${claimedSession.sessionId}');`,
  ]);
  const rejectedTargetStatusResponse = await fetch(
    new URL(`/v1/sessions/${claimedSession.sessionId}`, apiUrl),
    {
      headers: {
        authorization: `Bearer ${claimedSession.sessionToken}`,
      },
    },
  );
  const rejectedTargetStatus = await rejectedTargetStatusResponse.json();
  if (
    rejectedTargetStatusResponse.status !== 200 ||
    rejectedTargetStatus.status !== "failed"
  ) {
    throw new Error(
      `A rejected target hid its Session status behind authentication: ${rejectedTargetStatusResponse.status} ${JSON.stringify(rejectedTargetStatus)}`,
    );
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
    "-c",
    `update odyshell.agent_session_targets set status = 'ready' where session_id = '${claimedSession.sessionId}'; update odyshell.sessions set status = 'ready', error = null where id in (select runtime_session_id from odyshell.agent_session_targets where session_id = '${claimedSession.sessionId}');`,
  ]);
  const scopedOperation = (action, idempotencyKey = crypto.randomUUID()) =>
    fetch(
      new URL(
        `/v1/sessions/${claimedSession.sessionId}/operations`,
        apiUrl,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${claimedSession.sessionToken}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          action,
          timeoutSeconds: 10,
          maxOutputBytes: 1024,
        }),
      },
    );
  const missingIdempotency = await fetch(
    new URL(`/v1/sessions/${claimedSession.sessionId}/operations`, apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${claimedSession.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: { kind: "fs.read", path: "approved.txt" },
        timeoutSeconds: 10,
        maxOutputBytes: 1024,
      }),
    },
  );
  if (missingIdempotency.status !== 400) {
    throw new Error("Operation creation accepted a missing idempotency key");
  }
  const oversizedIdempotency = await scopedOperation(
    { kind: "fs.read", path: "approved.txt" },
    "x".repeat(129),
  );
  if (oversizedIdempotency.status !== 400) {
    throw new Error("Oversized idempotency keys were accepted");
  }
  const wrongPath = await scopedOperation({
    kind: "fs.read",
    path: "different.txt",
  });
  if (wrongPath.status !== 403) {
    throw new Error("Session Credential exceeded its exact path scope");
  }
  const wrongCapability = await scopedOperation({
    kind: "fs.write",
    path: "approved.txt",
    contentBase64: "",
    createParents: false,
  });
  if (wrongCapability.status !== 403) {
    throw new Error("Session Credential exceeded its capability scope");
  }
  const wrongMachine = await fetch(
    new URL(`/v1/machines/${isolatedMachine.machineId}/ping`, apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${claimedSession.sessionToken}`,
      },
    },
  );
  if (wrongMachine.status !== 403) {
    throw new Error("Session Credential exceeded its machine scope");
  }
  const wrongSession = await fetch(
    new URL(
      `/v1/sessions/${crypto.randomUUID()}/operations`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${claimedSession.sessionToken}`,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        action: { kind: "fs.read", path: "approved.txt" },
        timeoutSeconds: 10,
        maxOutputBytes: 1024,
      }),
    },
  );
  if (wrongSession.status !== 403) {
    throw new Error("Session Credential exceeded its Session scope");
  }
  const newSessionAttempt = await fetch(new URL("/v1/sessions", apiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${claimedSession.sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      machineId: machine.id,
      profile: "workspace",
      ttlSeconds: 120,
      capabilities: ["fs.read"],
    }),
  });
  if (newSessionAttempt.status !== 410) {
    throw new Error("Legacy Session creation remained available to Session Credentials");
  }

  const crossSessionId = crypto.randomUUID();
  const crossSessionOperationId = crypto.randomUUID();
  const crossSessionIdempotencyKey = crypto.randomUUID();
  const crossSessionIdempotencyKeyHash = createHash("sha256")
    .update(crossSessionIdempotencyKey)
    .digest("hex");
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
      `values ('default', '${crossSessionId}', '${machine.id}', '${approvedAgentId}',`,
      "'workspace', '[\"fs.read\"]'::jsonb, 'ready', now() + interval '10 minutes');",
      "insert into odyshell.operations",
      "(workspace_id, id, session_id, principal_id, action, status, timeout_seconds, max_output_bytes, idempotency_scope_id, idempotency_fingerprint)",
      `values ('default', '${crossSessionOperationId}', '${crossSessionId}', '${approvedAgentId}',`,
      `'{"kind":"fs.read","path":"approved.txt"}'::jsonb, 'queued', 10, 1024, '${crossSessionId}', '${"0".repeat(64)}');`,
      "insert into odyshell.operation_idempotency_keys",
      "(workspace_id, operation_id, machine_id, idempotency_scope_id, principal_id, operation_kind, idempotency_key_hash)",
      `values ('default', '${crossSessionOperationId}', '${machine.id}', '${crossSessionId}', '${approvedAgentId}', 'fs.read', '${crossSessionIdempotencyKeyHash}');`,
    ].join(" "),
  ]);
  const approvedReadResponse = await scopedOperation({
    kind: "fs.read",
    path: "approved.txt",
  }, crossSessionIdempotencyKey);
  if (approvedReadResponse.status !== 202) {
    throw new Error(
      `Approved read was rejected: ${approvedReadResponse.status} ${await approvedReadResponse.text()}`,
    );
  }
  const approvedOperation = await approvedReadResponse.json();
  if (approvedOperation.id === crossSessionOperationId) {
    throw new Error(
      "A Session resolved another Session's idempotent Operation",
    );
  }
  const approvedRead = await waitUntil(
    async () => {
      const response = await fetch(
        new URL(`/v1/operations/${approvedOperation.id}`, apiUrl),
        {
          headers: {
            authorization: `Bearer ${claimedSession.sessionToken}`,
          },
        },
      );
      return response.json();
    },
    (value) =>
      !["queued", "delivered", "running", "cancellation_requested"].includes(
        value.status,
      ),
    "approved read operation",
  );
  const approvedOutput = approvedRead.events
    .map((event) =>
      Buffer.from(event.dataBase64, "base64").toString("utf8"),
    )
    .join("");
  if (
    approvedRead.status !== "succeeded" ||
    approvedOutput !== "approved session read"
  ) {
    throw new Error("Approved fs.read did not complete end to end");
  }
  const longOperationResponse = await scopedOperation({
    kind: "process.exec",
    program: "sleep",
    args: ["30"],
    cwd: ".",
  });
  const longOperation = await longOperationResponse.json();
  if (longOperationResponse.status !== 202) {
    throw new Error(
      `Bounded process did not start before cancellation: ${longOperationResponse.status} ${JSON.stringify(longOperation)}`,
    );
  }
  await waitUntil(
    async () =>
      JSON.parse(
        (
          await compose([
            "exec",
            "-T",
            "postgres",
            "psql",
            "-U",
            "odyshell",
            "-d",
            "odyshell",
            "-At",
            "-c",
            `select json_build_object('status', status) from odyshell.operations where id = '${longOperation.id}';`,
          ])
        ).trim(),
      ),
    (value) => value.status === "running",
    "running Operation before Session cancellation",
  );
  const prematureCompletionResponse = await fetch(
    new URL(
      `/v1/agent-sessions/${claimedSession.sessionId}/complete`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: approvedAgentId,
        outcome: "succeeded",
      }),
    },
  );
  if (
    prematureCompletionResponse.status !== 409 ||
    (await prematureCompletionResponse.json()).error !==
      "session_operations_active"
  ) {
    throw new Error("Session completion did not fail closed with active Operations");
  }
  const cancelActiveResponse = await fetch(
    new URL(
      `/v1/agent-sessions/${claimedSession.sessionId}/cancel`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: approvedAgentId }),
    },
  );
  const cancelActive = await cancelActiveResponse.json();
  if (cancelActiveResponse.status !== 200 || cancelActive.transitioned !== true) {
    throw new Error("Active Session cancellation failed");
  }
  const cancelledOperationStatus = await waitUntil(
    async () =>
      (
        await compose([
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "odyshell",
          "-d",
          "odyshell",
          "-At",
          "-c",
          `select status from odyshell.operations where id = '${longOperation.id}';`,
        ])
      ).trim(),
    (status) => status === "cancelled" || status === "execution_unknown",
    "Operation result after Session cancellation",
  );
  if (cancelledOperationStatus !== "cancelled") {
    throw new Error("Session cancellation did not terminate active authority");
  }
  const cancelledCredentialReplay = await scopedOperation({
    kind: "fs.read",
    path: "approved.txt",
  });
  if (cancelledCredentialReplay.status !== 401) {
    throw new Error("Cancelled Session Credential could be replayed");
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
      "update odyshell.operations set status = 'cancelled'",
      `where workspace_id = 'default' and id = '${crossSessionOperationId}';`,
      "update odyshell.sessions set status = 'closed'",
      `where workspace_id = 'default' and id = '${crossSessionId}';`,
    ].join(" "),
  ]);
  await waitUntil(
    async () => {
      const response = await fetch(
        new URL(
          `/v1/agent-sessions/${claimedSession.sessionId}/timeline`,
          apiUrl,
        ),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${cliToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ agentId: approvedAgentId }),
        },
      );
      return response.json();
    },
    (value) =>
      value.data?.some(
        (event) => event.eventType === "operation.completed",
      ) &&
      value.data?.some((event) => event.eventType === "session.closed"),
    "privacy-minimal Session Timeline",
  );
  const timelineExportResponse = await fetch(
    new URL(
      `/v1/admin/sessions/${claimedSession.sessionId}/timeline/export?detailLevel=privacy-minimal`,
      apiUrl,
    ),
    {
      headers: { "x-odyshell-admin-key": adminKey },
    },
  );
  const exportedTimeline = await timelineExportResponse.json();
  if (
    timelineExportResponse.status !== 200 ||
    exportedTimeline.version !== "2026-07-31" ||
    exportedTimeline.sessionId !== claimedSession.sessionId ||
    !Array.isArray(exportedTimeline.events) ||
    JSON.stringify(exportedTimeline).match(
      /ods_session_|approved content|session-secret/iu,
    )
  ) {
    throw new Error("Versioned Timeline export was invalid or leaked data");
  }
  const renewalPredecessorRequestResponse = await fetch(
    new URL("/v1/agent-session-requests", apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: approvedAgentId,
        agentName: "E2E MCP Agent",
        title: "Create an active renewal predecessor",
        purpose: "Verify linked Session renewal from active authority",
        scopes: [
          {
            machineId: machine.id,
            profile: "workspace",
            capabilities: ["fs.read", "process.exec"],
            restrictions: {
              filesystem: {
                paths: [
                  { path: "approved.txt", includeDescendants: false },
                ],
              },
              process: {
                programs: [
                  {
                    program: "sleep",
                    args: ["30"],
                    cwd: { path: ".", includeDescendants: false },
                  },
                ],
              },
            },
          },
        ],
        durationSeconds: 600,
      }),
    },
  );
  const renewalPredecessorRequest =
    await renewalPredecessorRequestResponse.json();
  if (
    renewalPredecessorRequestResponse.status !== 201 ||
    !renewalPredecessorRequest.approvalUrl
  ) {
    throw new Error(
      `Renewal predecessor request failed: ${renewalPredecessorRequestResponse.status} ${JSON.stringify(renewalPredecessorRequest)}`,
    );
  }
  const renewalPredecessorCode = new URL(
    renewalPredecessorRequest.approvalUrl,
  ).searchParams.get("request");
  if (!renewalPredecessorCode) {
    throw new Error("Renewal predecessor approval omitted its code");
  }
  const renewalPredecessorApproval = await fetch(
    new URL("/v1/internal/cloud/session-requests/approve", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...approvalBody,
        requestId: renewalPredecessorCode,
      }),
    },
  );
  if (renewalPredecessorApproval.status !== 200) {
    throw new Error("Renewal predecessor approval failed");
  }
  const renewalPredecessorClaimResponse = await fetch(
    new URL(
      `/v1/agent-session-requests/${renewalPredecessorRequest.id}/claim`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: approvedAgentId }),
    },
  );
  const renewalPredecessor = await renewalPredecessorClaimResponse.json();
  if (
    renewalPredecessorClaimResponse.status !== 201 ||
    !renewalPredecessor.sessionId ||
    !renewalPredecessor.sessionToken
  ) {
    throw new Error(
      `Renewal predecessor claim failed: ${renewalPredecessorClaimResponse.status} ${JSON.stringify(renewalPredecessor)}`,
    );
  }
  const renewalPredecessorReady = await waitUntil(
    async () => {
      const response = await fetch(
        new URL(`/v1/sessions/${renewalPredecessor.sessionId}`, apiUrl),
        {
          headers: {
            authorization: `Bearer ${renewalPredecessor.sessionToken}`,
          },
        },
      );
      return response.json();
    },
    (value) => value.status === "ready" || value.status === "failed",
    "active renewal predecessor",
  );
  if (renewalPredecessorReady.status !== "ready") {
    throw new Error(
      `Renewal predecessor failed to open: ${renewalPredecessorReady.error ?? "unknown"}`,
    );
  }
  const renewalResponse = await fetch(
    new URL(
      `/v1/agent-sessions/${renewalPredecessor.sessionId}/renew`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: approvedAgentId,
        durationSeconds: 600,
      }),
    },
  );
  const renewalRequest = await renewalResponse.json();
  if (
    renewalResponse.status !== 201 ||
    renewalRequest.predecessorSessionId !== renewalPredecessor.sessionId
  ) {
    throw new Error(
      `Session renewal failed: ${renewalResponse.status} ${JSON.stringify(renewalRequest)}`,
    );
  }
  const renewalCode = new URL(renewalRequest.approvalUrl).searchParams.get(
    "request",
  );
  if (!renewalCode) throw new Error("Renewal approval omitted its code");
  const renewalApproval = await fetch(
    new URL("/v1/internal/cloud/session-requests/approve", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...approvalBody,
        requestId: renewalCode,
      }),
    },
  );
  if (renewalApproval.status !== 200) {
    throw new Error("Renewal approval failed");
  }
  const renewalClaimResponse = await fetch(
    new URL(
      `/v1/agent-session-requests/${renewalRequest.id}/claim`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: approvedAgentId }),
    },
  );
  const renewedSession = await renewalClaimResponse.json();
  if (
    renewalClaimResponse.status !== 201 ||
    renewedSession.sessionId === renewalPredecessor.sessionId
  ) {
    throw new Error("Renewal did not create a successor Session");
  }
  const predecessorLink = (
    await compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "odyshell",
      "-d",
      "odyshell",
      "-At",
      "-c",
      `select predecessor_session_id from odyshell.agent_sessions where id = '${renewedSession.sessionId}';`,
    ])
  ).trim();
  if (predecessorLink !== renewalPredecessor.sessionId) {
    throw new Error("Renewed Session did not retain its predecessor link");
  }
  const cloudIdentityBody = {
    userId: cliUserId,
    organization: approvalBody.organization,
  };
  const manualSessionRequest = {
    ...cloudIdentityBody,
    title: "Manual security boundary",
    agentId: approvedAgentId,
    durationSeconds: 3_600,
  };
  const [manualExecResponse, manualDockerResponse] = await Promise.all([
    fetch(new URL("/v1/internal/cloud/sessions/create", apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...manualSessionRequest,
        scopes: [{
          machineId: machine.id,
          profile: "default",
          capabilities: ["process.exec"],
          restrictions: {
            process: {
              programs: [{
                program: "node",
                args: ["--version"],
                cwd: { path: ".", includeDescendants: false },
              }],
            },
          },
        }],
      }),
    }),
    fetch(new URL("/v1/internal/cloud/sessions/create", apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...manualSessionRequest,
        scopes: [{
          machineId: machine.id,
          profile: "default",
          capabilities: ["docker.logs"],
          restrictions: { docker: { containers: ["postgres"] } },
        }],
      }),
    }),
  ]);
  if (manualExecResponse.status !== 400 || manualDockerResponse.status !== 400) {
    throw new Error("Manual Session creation accepted a low-level capability");
  }
  const cloudSessionsResponse = await fetch(
    new URL("/v1/internal/cloud/sessions/list", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify(cloudIdentityBody),
    },
  );
  const cloudSessions = await cloudSessionsResponse.json();
  if (
    cloudSessionsResponse.status !== 200 ||
    !cloudSessions.data?.some(
      (session) => session.id === renewedSession.sessionId,
    )
  ) {
    throw new Error("Workspace Session listing omitted the renewed Session");
  }
  const cloudSessionDetailResponse = await fetch(
    new URL("/v1/internal/cloud/sessions/inspect", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...cloudIdentityBody,
        sessionId: renewedSession.sessionId,
      }),
    },
  );
  const cloudSessionDetail = await cloudSessionDetailResponse.json();
  if (
    cloudSessionDetailResponse.status !== 200 ||
    cloudSessionDetail.session?.id !== renewedSession.sessionId ||
    JSON.stringify(cloudSessionDetail.timeline).match(
      /"path"|"stdout"|"stderr"|"token"/u,
    )
  ) {
    throw new Error("Workspace Session detail was unavailable or not privacy-minimal");
  }
  const completeRenewed = () =>
    fetch(
      new URL(
        `/v1/agent-sessions/${renewedSession.sessionId}/complete`,
        apiUrl,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentId: approvedAgentId,
          outcome: "succeeded",
          summary: "Verified the renewed Session lifecycle",
        }),
      },
    );
  const raceOperationIdempotencyKey = crypto.randomUUID();
  const [raceOperationResponse, raceCompletionResponse] = await Promise.all([
    fetch(
      new URL(
        `/v1/sessions/${renewedSession.sessionId}/operations`,
        apiUrl,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${renewedSession.sessionToken}`,
          "content-type": "application/json",
          "idempotency-key": raceOperationIdempotencyKey,
        },
        body: JSON.stringify({
          action: {
            kind: "process.exec",
            program: "sleep",
            args: ["30"],
            cwd: ".",
          },
          timeoutSeconds: 60,
          maxOutputBytes: 1024,
        }),
      },
    ),
    completeRenewed(),
  ]);
  if (
    raceOperationResponse.status === 202 &&
    raceCompletionResponse.status === 200
  ) {
    throw new Error("Session completion raced past Operation creation");
  }
  if (raceOperationResponse.status === 202) {
    const raceOperation = await raceOperationResponse.json();
    const cancellationResponse = await fetch(
      new URL(`/v1/operations/${raceOperation.id}/cancel`, apiUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${renewedSession.sessionToken}`,
        },
      },
    );
    if (cancellationResponse.status !== 202) {
      throw new Error("Could not cancel the Operation used by the completion race test");
    }
    await waitUntil(
      async () => {
        const response = await fetch(
          new URL(`/v1/operations/${raceOperation.id}`, apiUrl),
          {
            headers: {
              authorization: `Bearer ${renewedSession.sessionToken}`,
            },
          },
        );
        return response.json();
      },
      (operation) =>
        !["queued", "delivered", "running", "cancellation_requested"].includes(
          operation.status,
        ),
      "completion race Operation cancellation",
    );
  } else if (raceCompletionResponse.status !== 200) {
    throw new Error(
      `Completion race failed closed on neither side: operation=${raceOperationResponse.status} completion=${raceCompletionResponse.status}`,
    );
  }
  const firstCompletionResponse =
    raceCompletionResponse.status === 200
      ? raceCompletionResponse
      : await completeRenewed();
  const firstCompletion = await firstCompletionResponse.json();
  const replayCompletionResponse = await completeRenewed();
  const replayCompletion = await replayCompletionResponse.json();
  if (
    firstCompletionResponse.status !== 200 ||
    firstCompletion.status !== "completed" ||
    firstCompletion.transitioned !== true ||
    replayCompletionResponse.status !== 200 ||
    replayCompletion.status !== "completed" ||
    replayCompletion.transitioned !== false
  ) {
    throw new Error(
      `Session completion was not idempotent: first=${firstCompletionResponse.status}/${JSON.stringify(firstCompletion)} replay=${replayCompletionResponse.status}/${JSON.stringify(replayCompletion)}`,
    );
  }
  const completionTimeline = (
    await compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "odyshell",
      "-d",
      "odyshell",
      "-At",
      "-c",
      `select source || ':' || ((metadata::jsonb)->>'outcome') from odyshell.session_timeline_events where session_id = '${renewedSession.sessionId}' and event_type = 'session.outcome_reported';`,
    ])
  ).trim();
  if (completionTimeline !== "agent:succeeded") {
    throw new Error("Session completion outcome was not recorded as agent-reported");
  }
  await waitUntil(
    async () => ({
      status: (
        await compose([
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "odyshell",
          "-d",
          "odyshell",
          "-At",
          "-c",
          `select s.status from odyshell.sessions s join odyshell.agent_session_targets t on t.runtime_session_id = s.id where t.session_id = '${renewedSession.sessionId}';`,
        ])
      ).trim(),
    }),
    (value) => value.status === "closed",
    "renewed Session Client cleanup",
  );
  const revokedReplay = await fetch(
    new URL(
      `/v1/sessions/${renewedSession.sessionId}/operations`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${renewedSession.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: { kind: "fs.read", path: "approved.txt" },
        timeoutSeconds: 10,
        maxOutputBytes: 1024,
      }),
    },
  );
  if (revokedReplay.status !== 401) {
    throw new Error("A completed Session Credential could be replayed");
  }
  const storedCredentialLeak = (
    await compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "odyshell",
      "-d",
      "odyshell",
      "-At",
      "-c",
      `select count(*) from odyshell.session_credentials where token_hash = '${claimedSession.sessionToken}';`,
    ])
  ).trim();
  if (storedCredentialLeak !== "0") {
    throw new Error("Session Credential was stored in plaintext");
  }

  const crossWorkspacePing = await fetch(
    new URL(`/v1/machines/${isolatedMachine.machineId}/ping`, apiUrl),
    {
      method: "POST",
      headers: { authorization: `Bearer ${cliToken}` },
    },
  );
  if (crossWorkspacePing.status !== 403) {
    throw new Error("CLI credential could ping a machine from another workspace");
  }
  const crossWorkspaceSession = await fetch(new URL("/v1/sessions", apiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      machineId: machine.id,
      profile: "workspace",
      ttlSeconds: 120,
      capabilities: ["process.exec"],
    }),
  });
  if (crossWorkspaceSession.status !== 410) {
    throw new Error("Legacy Session creation did not return migration guidance");
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
  if (crossWorkspaceGrant.status !== 410) {
    throw new Error("Legacy Agent Access route remained authoritative");
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

  const targetHumanId = crypto.randomUUID();
  const targetAgentId = crypto.randomUUID();
  const targetManagedAgentId = crypto.randomUUID();
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
      "insert into odyshell.humans",
      "(workspace_id, id, external_id, status)",
      `values ('default', '${targetHumanId}', 'e2e-human', 'active');`,
      "insert into odyshell.agents",
      "(workspace_id, id, name, kind, created_by_human_id, status)",
      `values ('default', '${targetAgentId}', 'E2E Agent', 'independent', '${targetHumanId}', 'active');`,
      "insert into odyshell.agents",
      "(workspace_id, id, name, kind, parent_agent_id, created_by_human_id, status)",
      `values ('default', '${targetManagedAgentId}', 'Managed E2E Agent', 'managed', '${targetAgentId}', '${targetHumanId}', 'active');`,
    ].join(" "),
  ]);
  let targetSessionBoundaryRejected = false;
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
        "insert into odyshell.agent_sessions",
        "(workspace_id, id, agent_id, title, purpose, status, expires_at)",
        `values ('${isolatedWorkspace.id}', '${crypto.randomUUID()}', '${targetAgentId}',`,
        "'Cross workspace', 'cross-workspace', 'active', now() + interval '1 minute');",
      ].join(" "),
    ]);
  } catch {
    targetSessionBoundaryRejected = true;
  }
  if (!targetSessionBoundaryRejected) {
    throw new Error("PostgreSQL accepted Agent authority across workspaces");
  }
  let legacyAuthorityEscalationRejected = false;
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
        "insert into odyshell.agent_sessions",
        "(workspace_id, id, agent_id, title, purpose, status, expires_at)",
        `values ('${isolatedWorkspace.id}', '${crypto.randomUUID()}', '${crypto.randomUUID()}',`,
        "'Legacy escalation', 'legacy-escalation', 'active', now() + interval '1 minute');",
      ].join(" "),
    ]);
  } catch {
    legacyAuthorityEscalationRejected = true;
  }
  if (!legacyAuthorityEscalationRejected) {
    throw new Error("Legacy Agent Access became canonical Session authority");
  }
  let managedAgentCredentialRejected = false;
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
        "insert into odyshell.agent_credentials",
        "(workspace_id, id, agent_id, agent_kind, token_hash, status, expires_at)",
        `values ('default', '${crypto.randomUUID()}', '${targetManagedAgentId}',`,
        `'independent', 'managed-${crypto.randomUUID()}', 'active', now() + interval '1 day');`,
      ].join(" "),
    ]);
  } catch {
    managedAgentCredentialRejected = true;
  }
  if (!managedAgentCredentialRejected) {
    throw new Error("PostgreSQL issued a credential to a managed Agent");
  }
  let overlongAgentCredentialRejected = false;
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
        "insert into odyshell.agent_credentials",
        "(workspace_id, id, agent_id, agent_kind, token_hash, status, expires_at)",
        `values ('default', '${crypto.randomUUID()}', '${targetAgentId}',`,
        `'independent', 'overlong-${crypto.randomUUID()}', 'active', now() + interval '1 year 1 second');`,
      ].join(" "),
    ]);
  } catch {
    overlongAgentCredentialRejected = true;
  }
  if (!overlongAgentCredentialRejected) {
    throw new Error("PostgreSQL accepted an Agent Credential beyond one year");
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
      "insert into odyshell.agent_credentials",
      "(workspace_id, id, agent_id, agent_kind, token_hash, status, expires_at)",
      `values ('default', '${crypto.randomUUID()}', '${targetAgentId}',`,
      `'independent', 'valid-${crypto.randomUUID()}', 'active', now() + interval '1 day');`,
    ].join(" "),
  ]);
  const targetSessionId = crypto.randomUUID();
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
      "insert into odyshell.agent_sessions",
      "(workspace_id, id, agent_id, title, purpose, status, expires_at)",
      `values ('default', '${targetSessionId}', '${targetAgentId}',`,
      "'Credential lifetime', 'credential-lifetime', 'active', now() + interval '1 minute');",
    ].join(" "),
  ]);
  let orphanSessionCredentialRejected = false;
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
        "insert into odyshell.session_credentials",
        "(workspace_id, id, session_id, token_hash, status, expires_at, claimed_at)",
        `values ('default', '${crypto.randomUUID()}', '${crypto.randomUUID()}',`,
        `'orphan-session-${crypto.randomUUID()}', 'active', now() + interval '1 minute', now());`,
      ].join(" "),
    ]);
  } catch {
    orphanSessionCredentialRejected = true;
  }
  if (!orphanSessionCredentialRejected) {
    throw new Error("A Session Credential referenced an unknown Session");
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
      "insert into odyshell.session_credentials",
      "(workspace_id, id, session_id, token_hash, status, expires_at, claimed_at)",
      "select workspace_id,",
      `'${crypto.randomUUID()}', id, 'valid-session-${crypto.randomUUID()}', 'active',`,
      "expires_at, now()",
      "from odyshell.agent_sessions",
      `where workspace_id = 'default' and id = '${targetSessionId}';`,
    ].join(" "),
  ]);

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

  const privacyMinimalLoggingResponse = await fetch(
    new URL("/v1/internal/cloud/workspace/settings/update", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...cloudIdentityBody,
        section: "logging",
        loggingLevel: "privacy-minimal",
      }),
    },
  );
  if (privacyMinimalLoggingResponse.status !== 200) {
    throw new Error("Could not prepare privacy-minimal Host Shell coverage");
  }

  const hostShellRunId = crypto.randomUUID();
  const hostShellRequestResponse = await fetch(
    new URL("/v1/agent-session-requests", apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: approvedAgentId,
        agentName: "E2E MCP Agent",
        title: "Verify native Host Shell",
        purpose: "Run two harmless native commands in independent shells",
        runId: hostShellRunId,
        scopes: [
          {
            machineId: machine.id,
            profile: "host",
            capabilities: ["host.shell"],
            restrictions: {},
          },
        ],
        durationSeconds: 300,
      }),
    },
  );
  const hostShellRequest = await hostShellRequestResponse.json();
  if (
    hostShellRequestResponse.status !== 201 ||
    hostShellRequest.status !== "pending" ||
    !hostShellRequest.approvalUrl
  ) {
    throw new Error(
      `Host Shell Session request failed: ${hostShellRequestResponse.status} ${JSON.stringify(hostShellRequest)}`,
    );
  }
  const hostShellApprovalCode = new URL(
    hostShellRequest.approvalUrl,
  ).searchParams.get("request");
  if (!hostShellApprovalCode) {
    throw new Error("Host Shell approval URL omitted its request code");
  }
  const hostShellApprovalResponse = await fetch(
    new URL("/v1/internal/cloud/session-requests/approve", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...approvalBody,
        requestId: hostShellApprovalCode,
      }),
    },
  );
  if (hostShellApprovalResponse.status !== 200) {
    throw new Error(
      `Host Shell Session approval failed: ${hostShellApprovalResponse.status} ${await hostShellApprovalResponse.text()}`,
    );
  }
  const hostShellClaimResponse = await fetch(
    new URL(
      `/v1/agent-session-requests/${hostShellRequest.id}/claim`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: approvedAgentId,
        runId: hostShellRunId,
      }),
    },
  );
  const hostShellSession = await hostShellClaimResponse.json();
  if (
    hostShellClaimResponse.status !== 201 ||
    !hostShellSession.sessionId ||
    !hostShellSession.sessionToken
  ) {
    throw new Error(
      `Host Shell Session claim failed: ${hostShellClaimResponse.status} ${JSON.stringify(hostShellSession)}`,
    );
  }
  const hostShellReady = await waitUntil(
    async () => {
      const response = await fetch(
        new URL(`/v1/sessions/${hostShellSession.sessionId}`, apiUrl),
        {
          headers: {
            authorization: `Bearer ${hostShellSession.sessionToken}`,
          },
        },
      );
      return response.json();
    },
    (value) => value.status === "ready" || value.status === "failed",
    "Host Shell Session readiness",
  );
  if (hostShellReady.status !== "ready") {
    throw new Error(`Host Shell Session failed to open: ${hostShellReady.error ?? "unknown"}`);
  }
  const startHostShell = async (action) => {
    const response = await fetch(
      new URL(
        `/v1/sessions/${hostShellSession.sessionId}/operations`,
        apiUrl,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${hostShellSession.sessionToken}`,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          machineId: machine.id,
          action,
          timeoutSeconds: 10,
          maxOutputBytes: 1024,
        }),
      },
    );
    const created = await response.json();
    if (response.status !== 202 || !created.id) {
      throw new Error(
        `Host Shell Operation failed to start: ${response.status} ${JSON.stringify(created)}`,
      );
    }
    return created.id;
  };
  const readHostShell = async (operationId) => {
    const operationResponse = await fetch(
      new URL(`/v1/operations/${operationId}`, apiUrl),
      {
        headers: {
          authorization: `Bearer ${hostShellSession.sessionToken}`,
        },
      },
    );
    return operationResponse.json();
  };
  const waitForHostShell = async (operationId, expectedStatus) => {
    const completed = await waitUntil(
      () => readHostShell(operationId),
      (value) =>
        !["queued", "delivered", "running", "cancellation_requested"].includes(
          value.status,
        ),
      `Host Shell Operation ${operationId}`,
    );
    if (completed.status !== expectedStatus) {
      throw new Error(
        `Host Shell Operation ${operationId} produced ${completed.status}: ${completed.error ?? ""}`,
      );
    }
    const output = (stream) => completed.events
      .filter((event) => event.stream === stream)
      .map((event) => Buffer.from(event.dataBase64, "base64").toString("utf8"))
      .join("");
    return {
      id: operationId,
      status: completed.status,
      stdout: output("stdout"),
      stderr: output("stderr"),
    };
  };
  const runHostShell = async (action, expectedStatus = "succeeded") =>
    waitForHostShell(await startHostShell(action), expectedStatus);
  const lastOutputLine = (output) =>
    output.trim().split(/\r?\n/u).filter(Boolean).at(-1) ?? "";
  const workingDirectoryCommand = machine.runtime.hostPlatform === "windows"
    ? "cd"
    : "pwd";
  const hostShellWorkspace = await runHostShell({
    kind: "host.shell",
    command: workingDirectoryCommand,
    cwd: workspace,
    env: {},
  });
  const hostShellHome = await runHostShell({
    kind: "host.shell",
    command: workingDirectoryCommand,
    env: {},
  });
  const stateMutationCommand = machine.runtime.hostPlatform === "windows"
    ? "set ODYSHELL_E2E_STATE=leaked"
    : "export ODYSHELL_E2E_STATE=leaked";
  const stateReadCommand = machine.runtime.hostPlatform === "windows"
    ? "if defined ODYSHELL_E2E_STATE (echo leaked) else (echo missing)"
    : "printf '%s' \"${ODYSHELL_E2E_STATE:-missing}\"";
  await runHostShell({
    kind: "host.shell",
    command: stateMutationCommand,
    env: {},
  });
  const isolatedState = await runHostShell({
    kind: "host.shell",
    command: stateReadCommand,
    env: {},
  });
  const missingProgram = `odyshell-command-not-installed-${process.pid}`;
  await runHostShell({
    kind: "host.shell",
    command: missingProgram,
    env: {},
  }, "failed");
  const continuedAfterFailure = await runHostShell({
    kind: "host.shell",
    command: "echo odyshell-shell-still-usable",
    env: {},
  });
  const identityCommand = machine.runtime.hostPlatform === "windows"
    ? "whoami"
    : "id -u";
  const hostShellIdentity = await runHostShell({
    kind: "host.shell",
    command: identityCommand,
    env: {},
  });
  const expectedIdentity = machine.runtime.hostPlatform === "windows"
    ? (await run("whoami", [])).trim().toLowerCase()
    : String(process.getuid());
  const comparablePath = (path) => {
    const normalized = resolve(path);
    return machine.runtime.hostPlatform === "windows"
      ? normalized.toLowerCase()
      : normalized;
  };
  if (
    hostShellWorkspace.id === hostShellHome.id ||
    comparablePath(lastOutputLine(hostShellWorkspace.stdout)) !==
      comparablePath(workspace) ||
    comparablePath(lastOutputLine(hostShellHome.stdout)) !==
      comparablePath(homedir()) ||
    lastOutputLine(isolatedState.stdout) !== "missing" ||
    lastOutputLine(continuedAfterFailure.stdout) !==
      "odyshell-shell-still-usable" ||
    lastOutputLine(hostShellIdentity.stdout).toLowerCase() !== expectedIdentity
  ) {
    throw new Error(
      "Host Shell Operations did not preserve independent native same-user execution from Home",
    );
  }
  const hostShellInspectionResponse = await fetch(
    new URL("/v1/internal/cloud/sessions/inspect", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...cloudIdentityBody,
        sessionId: hostShellSession.sessionId,
      }),
    },
  );
  const hostShellInspection = await hostShellInspectionResponse.json();
  if (
    hostShellInspectionResponse.status !== 200 ||
    hostShellInspection.session?.loggingLevel !== "privacy-minimal" ||
    hostShellInspection.recentHostShellCommands?.[continuedAfterFailure.id] !==
      "echo odyshell-shell-still-usable" ||
    JSON.stringify(hostShellInspection.timeline).includes('"command"')
  ) {
    throw new Error(
      "Authenticated Session inspection did not separate the recent Host Shell command from its privacy-minimal Timeline",
    );
  }
  const hostShellExportResponse = await fetch(
    new URL("/v1/internal/cloud/sessions/export", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...cloudIdentityBody,
        sessionId: hostShellSession.sessionId,
      }),
    },
  );
  const hostShellExport = await hostShellExportResponse.json();
  if (
    hostShellExportResponse.status !== 200 ||
    JSON.stringify(hostShellExport).includes('"command"')
  ) {
    throw new Error("Privacy-minimal Timeline export exposed a Host Shell command");
  }
  const hostShellCancellableId = await startHostShell({
    kind: "host.shell",
    command: 'node -e "setTimeout(() => {}, 30000)"',
    env: {},
  });
  await waitUntil(
    () => readHostShell(hostShellCancellableId),
    (operation) => operation.status === "running",
    "Host Shell cancellation startup",
  );
  const hostShellCancelResponse = await fetch(
    new URL(`/v1/operations/${hostShellCancellableId}/cancel`, apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${hostShellSession.sessionToken}`,
      },
    },
  );
  if (hostShellCancelResponse.status !== 202) {
    throw new Error(`Host Shell cancellation returned ${hostShellCancelResponse.status}`);
  }
  await waitForHostShell(hostShellCancellableId, "cancelled");
  const hostShellCompletionResponse = await fetch(
    new URL(
      `/v1/agent-sessions/${hostShellSession.sessionId}/complete`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: approvedAgentId,
        outcome: "succeeded",
        summary: "Verified two independent native Host Shell Operations",
      }),
    },
  );
  const hostShellCompletion = await hostShellCompletionResponse.json();
  if (
    hostShellCompletionResponse.status !== 200 ||
    hostShellCompletion.status !== "completed" ||
    hostShellCompletion.transitioned !== true
  ) {
    throw new Error(
      `Host Shell Session completion failed: ${hostShellCompletionResponse.status} ${JSON.stringify(hostShellCompletion)}`,
    );
  }
  await waitUntil(
    async () =>
      (
        await compose([
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "odyshell",
          "-d",
          "odyshell",
          "-At",
          "-c",
          `select status from odyshell.agent_session_targets where session_id = '${hostShellSession.sessionId}';`,
        ])
      ).trim(),
    (status) => status === "closed",
    "Host Shell target cleanup",
  );
  const operationalLoggingRestoreResponse = await fetch(
    new URL("/v1/internal/cloud/workspace/settings/update", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...cloudIdentityBody,
        section: "logging",
        loggingLevel: "operational",
      }),
    },
  );
  if (operationalLoggingRestoreResponse.status !== 200) {
    throw new Error("Could not restore operational Timeline logging after Host Shell coverage");
  }

  const locallyDeniedResponse = await fetch(
    new URL("/v1/agent-session-requests", apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: approvedAgentId,
        agentName: "E2E MCP Agent",
        title: "Reject Host Shell through the Docker profile",
        purpose: "Verify profile-scoped capability enforcement",
        runId: crypto.randomUUID(),
        scopes: [
          {
            machineId: machine.id,
            profile: "workspace",
            capabilities: ["host.shell"],
            restrictions: {},
          },
        ],
        durationSeconds: 120,
      }),
    },
  );
  const locallyDenied = await locallyDeniedResponse.json();
  if (
    locallyDeniedResponse.status !== 403 ||
    locallyDenied.error !== "agent_or_machine_denied"
  ) {
    throw new Error(
      `Docker profile accepted Host Shell authority: ${locallyDeniedResponse.status} ${JSON.stringify(locallyDenied)}`,
    );
  }

  const machineUpdateResponse = await fetch(
    new URL("/v1/internal/cloud/machines/update", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...cloudIdentity,
        machineId: machine.id,
        name: "e2e-machine-edited",
        description: "Docker-backed E2E machine",
        capabilities: clientCapabilities,
      }),
    },
  );
  const machineUpdate = await machineUpdateResponse.json();
  if (
    machineUpdateResponse.status !== 200 ||
    machineUpdate.description !== "Docker-backed E2E machine" ||
    machineUpdate.capabilities.includes("host.shell")
  ) {
    throw new Error("Cloud machine metadata update failed");
  }
  const widenedMachineUpdate = await fetch(
    new URL("/v1/internal/cloud/machines/update", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...cloudIdentity,
        machineId: machine.id,
        name: "e2e-machine-edited",
        description: "Docker-backed E2E machine",
        capabilities: [...clientCapabilities, "host.shell"],
      }),
    },
  );
  if (widenedMachineUpdate.status !== 403) {
    throw new Error("Cloud machine policy widened the Client Local Policy");
  }
  const crossWorkspaceMachineUpdate = await fetch(
    new URL("/v1/internal/cloud/machines/update", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        userId: cliUserId,
        organization: {
          externalId: "org_machine_attacker",
          slug: "machine-attacker",
          name: "Machine Attacker",
        },
        machineId: machine.id,
        name: "stolen-machine",
        description: "Cross-workspace update",
        capabilities: clientCapabilities,
      }),
    },
  );
  if (crossWorkspaceMachineUpdate.status !== 404) {
    throw new Error("Cloud machine metadata crossed its Workspace boundary");
  }
  const restoreMachineName = await fetch(
    new URL("/v1/internal/cloud/machines/update", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        ...cloudIdentity,
        machineId: machine.id,
        name: machine.name,
        description: "Docker-backed E2E machine",
        capabilities: clientCapabilities,
      }),
    },
  );
  if (restoreMachineName.status !== 200) {
    throw new Error("Cloud machine name restore failed");
  }

  const cliMachines = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
      "--server",
      apiUrl,
      "--agent-token",
      cliToken,
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
      cliToken,
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
    cliToken,
    "ping",
    "e2e-docker",
  ]);
  if (cliPingText.trim() !== "Pong! 🏓") {
    throw new Error("ods ping did not print the expected pong");
  }

  const cliAgentDeviceResponse = await fetch(
    new URL("/v1/auth/agent/device", apiUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentName: "E2E CLI Agent" }),
    },
  );
  const cliAgentDevice = await cliAgentDeviceResponse.json();
  if (cliAgentDeviceResponse.status !== 201) {
    throw new Error("CLI Agent registration did not start");
  }
  const cliAgentApproval = await fetch(
    new URL("/v1/internal/cloud/agent-device/approve", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        userId: cliUserId,
        organization: approvalBody.organization,
        userCode: cliAgentDevice.userCode,
      }),
    },
  );
  if (cliAgentApproval.status !== 200) {
    throw new Error("CLI Agent registration was not approved");
  }
  const cliAgentExchangeResponse = await fetch(
    new URL("/v1/auth/agent/device/token", apiUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: cliAgentDevice.deviceCode }),
    },
  );
  const cliAgentCredential = await cliAgentExchangeResponse.json();
  if (
    cliAgentExchangeResponse.status !== 200 ||
    !cliAgentCredential.accessToken
  ) {
    throw new Error("CLI Agent Credential was not issued");
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
  if (
    !listedAgents.data.some(
      (agent) =>
        agent.id === cliAgentCredential.agentId &&
        agent.status === "active",
    )
  ) {
    throw new Error("ods agent list omitted the registered Agent identity");
  }
  const cliPolicyScope = {
    machineId: machine.id,
    profile: "workspace",
    capabilities: ["process.exec"],
    restrictions: {
      process: {
        programs: [
          {
            program: "printf",
            args: ["hello from ods CLI"],
            cwd: { path: ".", includeDescendants: false },
          },
        ],
      },
    },
  };
  const cliPolicyResponse = await fetch(
    new URL("/v1/agent-policies", apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliAgentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scopes: [cliPolicyScope],
        maxSessionSeconds: 300,
        validForSeconds: 24 * 60 * 60,
      }),
    },
  );
  const cliPolicy = await cliPolicyResponse.json();
  if (cliPolicyResponse.status !== 201 || !cliPolicy.approvalUrl) {
    throw new Error(
      `CLI execution policy was not proposed: ${cliPolicyResponse.status} ${JSON.stringify(cliPolicy)}`,
    );
  }
  const cliPolicyCode = new URL(cliPolicy.approvalUrl).searchParams.get("code");
  const cliPolicyApproval = await fetch(
    new URL("/v1/internal/cloud/agent-policies/approve", apiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        userId: cliUserId,
        organization: approvalBody.organization,
        approvalCode: cliPolicyCode,
      }),
    },
  );
  if (cliPolicyApproval.status !== 200) {
    throw new Error("CLI execution policy was not approved");
  }
  await writeFile(
    process.env.ODS_CONFIG_FILE,
    `${JSON.stringify(
      {
        serverUrl: apiUrl,
        workspaceId: "default",
        agentToken: cliAgentCredential.accessToken,
        mcpAgentId: cliAgentCredential.agentId,
        mcpAgentName: cliAgentCredential.agentName,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const cliExecution = JSON.parse(
    await run(process.execPath, [
      tsxCli,
      odsEntry,
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

  const legacyDevelopmentSessionId = crypto.randomUUID();
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
      `values ('default', '${legacyDevelopmentSessionId}', '${machine.id}', 'dev-agent',`,
      "'host', '[\"process.exec\"]'::jsonb, 'ready', now() + interval '10 minutes');",
    ].join(" "),
  ]);
  const legacyDevelopmentExecution = await fetch(
    new URL(
      `/v1/sessions/${legacyDevelopmentSessionId}/operations`,
      apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentKey}`,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        action: {
          kind: "process.exec",
          program: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
          args: process.platform === "win32"
            ? ["/d", "/s", "/c", "whoami"]
            : ["-lc", "id"],
          cwd: ".",
        },
        timeoutSeconds: 10,
        maxOutputBytes: 1024,
      }),
    },
  );
  const legacyDevelopmentExecutionBody =
    await legacyDevelopmentExecution.json();
  if (
    legacyDevelopmentExecution.status !== 403 ||
    legacyDevelopmentExecutionBody.error !== "manual_approval_required" ||
    legacyDevelopmentExecutionBody.capability !== "process.exec"
  ) {
    throw new Error(
      `A retained Development Session could execute natively: ${legacyDevelopmentExecution.status} ${JSON.stringify(legacyDevelopmentExecutionBody)}`,
    );
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
    `delete from odyshell.sessions where workspace_id = 'default' and id = '${legacyDevelopmentSessionId}';`,
  ]);

  const createApprovedSandboxSession = async ({
    title,
    purpose,
    capabilities,
    restrictions,
  }) => {
    const requestResponse = await fetch(
      new URL("/v1/agent-session-requests", apiUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentId: approvedAgentId,
          agentName: "E2E MCP Agent",
          title,
          purpose,
          scopes: [
            {
              machineId: machine.id,
              profile: "workspace",
              capabilities,
              restrictions,
            },
          ],
          durationSeconds: 300,
        }),
      },
    );
    const requested = await requestResponse.json();
    if (
      requestResponse.status !== 201 ||
      requested.status !== "pending" ||
      !requested.approvalUrl
    ) {
      throw new Error(
        `Sandbox Session request failed: ${requestResponse.status} ${JSON.stringify(requested)}`,
      );
    }
    const requestId = new URL(requested.approvalUrl).searchParams.get(
      "request",
    );
    if (!requestId) throw new Error("Sandbox approval URL omitted its request");
    const approval = await fetch(
      new URL("/v1/internal/cloud/session-requests/approve", apiUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-odyshell-web-key": webKey,
        },
        body: JSON.stringify({ ...approvalBody, requestId }),
      },
    );
    if (approval.status !== 200) {
      throw new Error(`Sandbox Session approval failed: ${approval.status}`);
    }
    const claimResponse = await fetch(
      new URL(`/v1/agent-session-requests/${requested.id}/claim`, apiUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: approvedAgentId }),
      },
    );
    const claimed = await claimResponse.json();
    if (
      claimResponse.status !== 201 ||
      !claimed.sessionId ||
      !claimed.sessionToken
    ) {
      throw new Error(
        `Sandbox Session claim failed: ${claimResponse.status} ${JSON.stringify(claimed)}`,
      );
    }
    const ready = await waitUntil(
      () => credentialApi(
        claimed.sessionToken,
        `/v1/sessions/${claimed.sessionId}`,
      ),
      (value) => value.status === "ready" || value.status === "failed",
      `${title} readiness`,
    );
    return {
      ...ready,
      id: claimed.sessionId,
      token: claimed.sessionToken,
    };
  };
  const waitForRuntimeSessionClosed = async (sessionId, description) =>
    await waitUntil(
      () =>
        compose([
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
          `select status from odyshell.sessions where workspace_id = 'default' and id = '${sessionId}';`,
        ]),
      (status) => status.trim() === "closed",
      description,
    );

  const readOnlySession = await createApprovedSandboxSession({
    title: "Verify read-only Docker isolation",
    purpose: "Prove the read-only mount rejects writes",
    capabilities: ["process.exec"],
    restrictions: {
      process: {
        programs: [
          {
            program: "touch",
            args: ["should-not-be-written"],
            cwd: { path: ".", includeDescendants: false },
          },
        ],
      },
    },
  });
  if (readOnlySession.status !== "ready") {
    const activeSessionRows = await compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "odyshell",
      "-d",
      "odyshell",
      "-At",
      "-c",
      `select id || ':' || status from odyshell.sessions where machine_id = '${machine.id}' and status in ('opening','ready','closing');`,
    ]);
    throw new Error(
      `Read-only sandbox failed: ${readOnlySession.error}; active=${activeSessionRows.trim()}; renewed=${renewedSession.sessionId}`,
    );
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
    },
    "failed",
    readOnlySession.token,
  );
  await credentialApi(readOnlySession.token, `/v1/sessions/${readOnlySession.id}`, {
    method: "DELETE",
  });
  await waitForRuntimeSessionClosed(
    readOnlySession.id,
    "read-only sandbox cleanup",
  );

  const processCwd = { path: ".", includeDescendants: false };
  const session = await createApprovedSandboxSession({
    title: "Verify isolated Docker execution",
    purpose: "Exercise structured execution and filesystem Operations",
    capabilities: clientCapabilities,
    restrictions: {
      process: {
        programs: [
          { program: "printf", args: ["idempotent"], cwd: processCwd },
          {
            program: "printf",
            args: ["hello from isolated Odyshell\\n"],
            cwd: processCwd,
          },
          {
            program: "wget",
            args: ["-T", "2", "-qO-", "http://example.com"],
            cwd: processCwd,
          },
          { program: "sleep", args: ["30"], cwd: processCwd },
        ],
      },
    },
  });
  if (session.status !== "ready") throw new Error(`Sandbox failed: ${session.error}`);

  const idempotencyKey = crypto.randomUUID();
  const idempotentRequest = () =>
    fetch(new URL(`/v1/sessions/${session.id}/operations`, apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.token}`,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        action: {
          kind: "process.exec",
          program: "printf",
          args: ["idempotent"],
          cwd: ".",
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
    () => credentialApi(session.token, `/v1/operations/${idempotentOperations[0].id}`),
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

  const execResult = await operation(
    session.id,
    {
      kind: "process.exec",
      program: "printf",
      args: ["hello from isolated Odyshell\\n"],
      cwd: ".",
    },
    "succeeded",
    session.token,
  );
  if (!execResult.output.includes("hello from isolated Odyshell")) {
    throw new Error("Structured execution output was not relayed");
  }

  await operation(
    session.id,
    {
      kind: "fs.write",
      path: "odyshell-e2e.txt",
      contentBase64: Buffer.from("filesystem round trip").toString("base64"),
      createParents: true,
    },
    "succeeded",
    session.token,
  );
  const readResult = await operation(
    session.id,
    { kind: "fs.read", path: "odyshell-e2e.txt" },
    "succeeded",
    session.token,
  );
  if (readResult.output !== "filesystem round trip") throw new Error("Filesystem round trip failed");

  const networkResult = await operation(
    session.id,
    {
      kind: "process.exec",
      program: "wget",
      args: ["-T", "2", "-qO-", "http://example.com"],
      cwd: ".",
    },
    "failed",
    session.token,
  );

  const traversal = await fetch(new URL(`/v1/sessions/${session.id}/operations`, apiUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      action: { kind: "fs.read", path: "../../etc/passwd" },
      timeoutSeconds: 10,
      maxOutputBytes: 1024,
    }),
  });
  if (traversal.status !== 400) throw new Error("Path traversal request was not rejected");

  const cancellable = await credentialApi(session.token, `/v1/sessions/${session.id}/operations`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      action: { kind: "process.exec", program: "sleep", args: ["30"], cwd: "." },
      timeoutSeconds: 60,
      maxOutputBytes: 1024,
    }),
  });
  await waitUntil(
    () => credentialApi(session.token, `/v1/operations/${cancellable.id}`),
    (value) => value.status === "running",
    "cancellable operation startup",
  );
  await credentialApi(session.token, `/v1/operations/${cancellable.id}/cancel`, {
    method: "POST",
  });
  const cancelled = await waitUntil(
    () => credentialApi(session.token, `/v1/operations/${cancellable.id}`),
    (value) =>
      !["queued", "delivered", "running", "cancellation_requested"].includes(
        value.status,
      ),
    "operation cancellation",
  );
  if (cancelled.status !== "cancelled") throw new Error(`Cancellation produced ${cancelled.status}`);

  const reconnectCancellable = await credentialApi(session.token, `/v1/sessions/${session.id}/operations`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      action: { kind: "process.exec", program: "sleep", args: ["30"], cwd: "." },
      timeoutSeconds: 60,
      maxOutputBytes: 1024,
    }),
  });
  await waitUntil(
    () => credentialApi(session.token, `/v1/operations/${reconnectCancellable.id}`),
    (value) => value.status === "running",
    "reconnect cancellation startup",
  );
  const replacementConnection = await supersedeMachineConnection(
    enrolledClientConfig,
  );
  await credentialApi(session.token, `/v1/operations/${reconnectCancellable.id}/cancel`, {
    method: "POST",
  });
  await replacementConnection.waitForCancellation(reconnectCancellable.id);
  const cancellationRequested = await credentialApi(
    session.token,
    `/v1/operations/${reconnectCancellable.id}`,
  );
  if (cancellationRequested.status !== "cancellation_requested") {
    throw new Error(
      `Disconnected cancellation produced ${cancellationRequested.status}`,
    );
  }
  replacementConnection.socket.close();
  const reconnectCancelled = await waitUntil(
    () => credentialApi(session.token, `/v1/operations/${reconnectCancellable.id}`),
    (value) =>
      !["queued", "delivered", "running", "cancellation_requested"].includes(
        value.status,
      ),
    "cancellation recovery after reconnect",
  );
  if (reconnectCancelled.status !== "cancelled") {
    throw new Error(
      `Reconnect cancellation produced ${reconnectCancelled.status}`,
    );
  }

  const scopedAudit = await waitUntil(
    () =>
      api("/v1/audit?limit=100", {
        headers: { authorization: `Bearer ${cliAgentCredential.accessToken}` },
      }),
    (value) => value.data.some((event) => event.action === "operation.completed"),
    "CLI Agent audit event",
  );
  if (
    scopedAudit.principal.id !== cliAgentCredential.agentId ||
    scopedAudit.data.some(
      (event) => event.principalId !== cliAgentCredential.agentId,
    )
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
      cliAgentCredential.accessToken,
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
        event.principalId === cliAgentCredential.agentId &&
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
      (event) => event.principalId === cliAgentCredential.agentId,
    )
  ) {
    throw new Error("Audit events leaked across workspace boundaries");
  }
  const operationCreatedAudit = adminAudit.data.find(
    (event) =>
      event.principalId === cliAgentCredential.agentId &&
      event.action === "operation.created",
  );
  if (
    !operationCreatedAudit ||
    Object.keys(operationCreatedAudit.metadata.operation ?? {}).join(",") !== "kind"
  ) {
    throw new Error("Durable audit metadata retained operation content");
  }

  await credentialApi(session.token, `/v1/sessions/${session.id}`, {
    method: "DELETE",
  });
  await waitForRuntimeSessionClosed(
    session.id,
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
      "where status not in ('queued', 'delivered', 'running', 'cancellation_requested');",
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
      "('default', 'retention-active-access', 'active', 'retention-active-hash', '[]'::jsonb, '[\"fs.read\"]'::jsonb, now() + interval '1 day', now()),",
      "('default', 'retention-inactive-access', 'inactive', 'retention-inactive-hash', '[]'::jsonb, '[\"fs.read\"]'::jsonb, now() - interval '31 days', now()),",
      "('default', 'retention-referenced-access', 'referenced', 'retention-referenced-hash', '[]'::jsonb, '[\"fs.read\"]'::jsonb, now() - interval '31 days', now()),",
      "('default', 'cutover-partial-access', 'partial', 'cutover-partial-hash', '[]'::jsonb, '[\"fs.read\"]'::jsonb, now() + interval '1 day', null);",
      "insert into odyshell.audit_events",
      "(workspace_id, id, principal_id, action, target_type, target_id, metadata)",
      "values",
      "('default', 'retention-reference-event', 'retention-referenced-access', 'agent_token.revoked', 'agent_token', 'retention-referenced-access', '{}'::jsonb);",
    ].join(" "),
  ]);
  await compose(["restart", "server"]);
  const failedServerId = (await compose(["ps", "-q", "server"])).trim();
  await waitUntil(
    async () =>
      JSON.parse(
        await run("docker", ["inspect", failedServerId, "--format", "{{json .State.Running}}"]),
      ),
    (running) => running === false,
    "fail-closed partial authority cutover",
  );
  const failedCutoverLogs = await compose([
    "logs",
    "--no-color",
    "--tail",
    "50",
    "server",
  ]);
  if (
    !failedCutoverLogs.includes("Authority cutover is incomplete") ||
    !failedCutoverLogs.includes("activeLegacyTokens=1")
  ) {
    throw new Error("Partial authority cutover did not fail closed safely");
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
    "update odyshell.agent_tokens set revoked_at = now() where id = 'cutover-partial-access';",
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
  const deletedAgentResponse = await fetch(
    new URL(`/v1/admin/agents/${agentCredential.agentId}`, apiUrl),
    {
      method: "DELETE",
      headers: { "x-odyshell-admin-key": adminKey },
    },
  );
  const deletedAgent = await deletedAgentResponse.json();
  if (
    deletedAgentResponse.status !== 200 ||
    deletedAgent.deleted !== true ||
    deletedAgent.deletedAgents < 1
  ) {
    throw new Error("An administrator could not delete an Agent hierarchy");
  }
  const agentsAfterDelete = await api("/v1/admin/agents", {
    headers: { "x-odyshell-admin-key": adminKey },
  });
  if (agentsAfterDelete.data.some((agent) => agent.id === agentCredential.agentId)) {
    throw new Error("A deleted Agent remained in the active Workspace list");
  }
  const deletedCredentialResponse = await fetch(
    new URL("/v1/agent-session-requests", apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotatedAgentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
  if (deletedCredentialResponse.status !== 401) {
    throw new Error("Deleting an Agent did not revoke its active Credential");
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
        "where status not in ('queued', 'delivered', 'running', 'cancellation_requested')",
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

  const quotaSeedAgentIds = [crypto.randomUUID(), crypto.randomUUID()];
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
      "update odyshell.organizations set plan = 'free' where id = 'default';",
      "update odyshell.agents set status = 'disabled', updated_at = now()",
      "where workspace_id = 'default' and status = 'active';",
      "insert into odyshell.agents",
      "(workspace_id, id, name, kind, parent_agent_id, created_by_human_id, status)",
      "values",
      `('default', '${quotaSeedAgentIds[0]}', 'Quota seed 1', 'independent', null, null, 'active'),`,
      `('default', '${quotaSeedAgentIds[1]}', 'Quota seed 2', 'independent', null, null, 'active');`,
    ].join(" "),
  ]);
  const quotaDeviceResponse = await fetch(
    new URL("/v1/auth/agent/device", apiUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentName: "Quota device contender" }),
    },
  );
  const quotaDevice = await quotaDeviceResponse.json();
  if (quotaDeviceResponse.status !== 201 || !quotaDevice.userCode) {
    throw new Error("Concurrent Agent quota authorization did not start");
  }
  const quotaHumanAgentId = crypto.randomUUID();
  const quotaContenders = await Promise.all([
    fetch(new URL("/v1/internal/cloud/agent-device/approve", apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-odyshell-web-key": webKey,
      },
      body: JSON.stringify({
        userId: cliUserId,
        organization: approvalBody.organization,
        userCode: quotaDevice.userCode,
      }),
    }),
    fetch(new URL("/v1/agent-session-requests", apiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: quotaHumanAgentId,
        agentName: "Quota human contender",
        title: "Exercise concurrent Agent quota",
        purpose: "Verify every Agent creation path shares one entitlement lock",
        scopes: [
          {
            machineId: machine.id,
            profile: "workspace",
            capabilities: ["fs.read"],
            restrictions: {
              filesystem: {
                paths: [{ path: "approved.txt", includeDescendants: false }],
              },
            },
          },
        ],
        durationSeconds: 300,
      }),
    }),
  ]);
  const quotaContenderBodies = await Promise.all(
    quotaContenders.map((response) => response.json()),
  );
  const quotaContenderStatuses = quotaContenders
    .map((response) => response.status)
    .sort((left, right) => left - right);
  if (
    quotaContenderStatuses.filter((status) => status === 200 || status === 201)
      .length !== 1 ||
    quotaContenderStatuses.filter((status) => status === 409).length !== 1 ||
    !quotaContenderBodies.some(
      (body) =>
        body.error === "agent_limit_reached" &&
        body.details?.plan === "free" &&
        body.details?.activeAgentLimit === 3,
    )
  ) {
    throw new Error(
      `Concurrent Agent quota was not enforced: ${JSON.stringify({ quotaContenderStatuses, quotaContenderBodies })}`,
    );
  }
  const activeAgentCount = (
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
        "select count(*) from odyshell.agents",
        "where workspace_id = 'default'",
        "and status = 'active'",
        "and deleted_at is null;",
      ].join(" "),
    ])
  ).trim();
  if (activeAgentCount !== "3") {
    throw new Error(
      `Concurrent Agent quota produced ${activeAgentCount} active Agents`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        machineId: machine.id,
        sessionId: session.id,
        checks: {
          outboundClient: true,
          clientProfileIdentity: true,
          organizationBoundary: true,
          organizationScopedWorkspaceSlugs: true,
          workspaceIsolation: true,
          crossWorkspaceAccessDenied: true,
          databaseWorkspaceBoundary: true,
          targetDatabaseWorkspaceBoundary: true,
          legacyAuthorityEscalationRejected: true,
          managedAgentCredentialRejected: true,
          managedAgentDelegation: true,
          managedAgentAttribution: true,
          delegationEscalationRejected: true,
          delegationCascadeRevoked: true,
          overlongAgentCredentialRejected: true,
          sessionCredentialReferenceBound: true,
          approvedSessionRead: approvedOutput,
          approvalReplayRejected: true,
          crossWorkspaceApprovalDenied: true,
          sessionClaimReplayRejected: true,
          exactPathScopeDenied: true,
          sessionCapabilityScopeDenied: true,
          sessionMachineScopeDenied: true,
          sessionIdScopeDenied: true,
          crossSessionIdempotencyIsolated: true,
          sessionCredentialCannotMintSessions: true,
          manualSessionExecDenied: true,
          manualSessionDockerDenied: true,
          developmentNativeExecDenied: true,
          hostShellApproved: true,
          hostShellIndependentCommands: true,
          hostShellHomeDefault: true,
          hostShellSameUser: true,
          hostShellContinuesAfterMissingCommand: true,
          hostShellProcessTreeCancellation: true,
          hostShellSessionCompleted: true,
          sessionTimeline: true,
          timelineExport: true,
          eventSinkSsrfDenied: true,
          sessionCredentialHashed: true,
          workspaceAuditIsolation: true,
          ed25519Authentication: true,
          runtimeMetadata: `${machine.runtime.hostPlatform}/${machine.runtime.architecture}`,
          machineMetadataPolicy: true,
          odsCli: true,
          odsWorkspaceSelection: true,
          odsPing: true,
          authorityCutover: true,
          activeAgentEntitlement: true,
          agentIdentityListed: true,
          agentIdentityDeletion: true,
          targetedNotifications: true,
          workspaceSettings: true,
          userSettings: true,
          legacyAgentAccessRejected: true,
          sessionBoundedByCredential: true,
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
          cancellationRecoveredAfterReconnect: true,
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
} catch (error) {
  const serverLogs = await compose([
    "logs",
    "--no-color",
    "--tail",
    "200",
    "server",
  ]).catch(() => "Server logs were unavailable.");
  process.stderr.write(`[server]\n${serverLogs}`);
  throw error;
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
