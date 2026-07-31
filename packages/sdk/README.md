<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell SDK</h1>

<p align="center"><strong>Give TypeScript agents temporary, scoped access to private machines.</strong></p>

`@odyshell/sdk` is the programmatic interface to Odyshell. An Agent Credential identifies the
Agent and requests temporary Sessions; only the claimed Session Credential can execute.

```ts
import { Odyshell } from "@odyshell/sdk";

const ods = new Odyshell({
  serverUrl: process.env.ODYSHELL_SERVER_URL!,
  agentToken: process.env.ODYSHELL_AGENT_TOKEN!,
});

const agent = ods.agent({ id: agentId, name: "Dependency auditor" });
const request = await agent.requestOperationSession({
  machineId,
  purpose: "Inspect repository state",
  durationSeconds: 900,
  action: {
    kind: "process.exec",
    program: "git",
    args: ["status", "--short"],
    cwd: ".",
    env: {},
  },
});
```

Headless orchestrators can register once through device authorization:

```ts
const authorization = await ods.startAgentDeviceAuthorization("OpenClaw");
// Present authorization.verificationUriComplete to an administrator.
const identity = await ods.exchangeAgentDeviceAuthorization(
  authorization.deviceCode,
);
```

Store `identity.accessToken` only in the trusted runtime. It proves Agent identity and can request
Sessions, but cannot execute Operations. `rotateAgentCredential()` issues a successor with a
bounded ten-minute overlap.

The SDK supports typed process, filesystem, and Docker log operations. Permissions are still
enforced by the Server, the agent token, and the Client on the target machine.

After approval, claim once and execute with the Session client:

```ts
// Show request.approvalUrl to the workspace member.
let status = await agent.status(request.id);
while (status.status === "pending") {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  status = await agent.status(request.id);
}
if (status.status !== "approved") throw new Error(`Request ${status.status}`);

const claim = await agent.claim(request.id);
const result = await ods.claimedSession(claim).execute(machineId, {
  kind: "process.exec",
  program: "git",
  args: ["status", "--short"],
  cwd: ".",
  env: {},
});
```

An unattended Agent can propose a bounded autoapproval policy:

```ts
const policy = await ods.proposeAgentPolicy({
  scopes,
  maxSessionSeconds: 600,
  validForSeconds: 30 * 24 * 60 * 60,
});

console.log(policy.approvalUrl);
```

The policy stays inactive until a workspace administrator approves that URL. Use
`agentPolicies()`, `pauseAgentPolicy(id)`, and `revokeAgentPolicy(id)` to inspect or reduce future
authority. Requests outside the ceiling still require human approval.

An approved Delegation Policy lets the Independent Agent derive one level of Managed Agents:

```ts
await ods.proposeAgentPolicy({
  kind: "delegation",
  scopes,
  maxSessionSeconds: 600,
  maxManagedAgents: 3,
  validForSeconds: 30 * 24 * 60 * 60,
});

const child = await ods.createManagedAgent({
  name: "Dependency updater",
  scopes,
  maxSessionSeconds: 600,
  validForSeconds: 60 * 60,
});
```

The child has no Agent Credential. Its parent requests and claims Sessions in its name, optionally
including a `runId` for Timeline attribution. Use `managedAgents()`,
`disableManagedAgent(child.id)`, or `deleteManagedAgent(child.id)` to manage it. Revoking the
parent credential cascades to every derived Agent and active Session.

`claim.sessionToken` is returned once. Keep it inside a trusted runtime; do not send it to a model,
log it, or persist it. `readApprovedSession` uses it only for the approved Session and closes that
Session after the read.

Cancel a claimed Session when the task finishes:

```ts
await ods.cancelAgentSession(claim.sessionId, agentId);
```

Export a redacted, versioned Timeline with `agent.exportTimeline(sessionId)`. Workspace
administrators can use `configureEventSink()`, `eventSink()` and `deleteEventSink()` for signed
delivery to a public HTTPS endpoint. Signing secrets are accepted on configuration and never
returned in full.

Renewal creates a successor with the same scope and requires a new approval:

```ts
const renewal = await ods.renewAgentSession(claim.sessionId, agentId, {
  durationSeconds: 900,
});
```

Restricted Sessions do not accept `process.shell`. Use `process.exec` with an explicit executable
and arguments.

Administrative SDK calls can select an execution Workspace:

```ts
const admin = new Odyshell({
  serverUrl: process.env.ODYSHELL_SERVER_URL!,
  adminKey: process.env.ODYSHELL_ADMIN_KEY!,
  workspaceId: process.env.ODYSHELL_WORKSPACE_ID!,
});

await admin.createEnrollmentToken(600);
```

The workspace header is never attached to agent calls. An agent's workspace is derived from its
token by the Server.

[Back to Odyshell](../../README.md)
