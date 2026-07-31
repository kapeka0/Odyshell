<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell SDK</h1>

<p align="center"><strong>Give TypeScript agents temporary, scoped access to private machines.</strong></p>

`@odyshell/sdk` is the programmatic interface to Odyshell. An agent uses its short-lived token to
find an allowed machine and request a typed operation. Odyshell opens a temporary session, sends
the operation through the machine's outbound connection, records it for audit, and closes the
session.

```ts
import { Odyshell } from "@odyshell/sdk";

const ods = new Odyshell({
  serverUrl: process.env.ODYSHELL_SERVER_URL!,
  agentToken: process.env.ODYSHELL_AGENT_TOKEN!,
});

const result = await ods.process.exec({
  machine: "rpi5",
  program: "git",
  args: ["status", "--short"],
});

console.log(result.stdout);
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

Trusted orchestrators can also use the approval flow:

```ts
const request = await ods.requestAgentSession({
  agentId,
  agentName: "Dependency auditor",
  purpose: "Inspect the application version",
  machineId,
  path: "package.json",
  durationSeconds: 900,
});

// Show request.approvalUrl to the workspace member.
let status = await ods.agentSessionRequestStatus(request.id, agentId);
while (status.status === "pending") {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  status = await ods.agentSessionRequestStatus(request.id, agentId);
}
if (status.status !== "approved") throw new Error(`Request ${status.status}`);

const claim = await ods.claimAgentSession(request.id, agentId);
const result = await ods.readApprovedSession(claim);
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

`claim.sessionToken` is returned once. Keep it inside a trusted runtime; do not send it to a model,
log it, or persist it. `readApprovedSession` uses it only for the approved Session and closes that
Session after the read.

Cancel a claimed Session when the task finishes:

```ts
await ods.cancelAgentSession(claim.sessionId, agentId);
```

Renewal creates a successor with the same scope and requires a new approval:

```ts
const renewal = await ods.renewAgentSession(claim.sessionId, agentId, {
  durationSeconds: 900,
});
```

Use `process.exec` when possible. `process.shell` is available for commands that genuinely need a
shell and should receive a separate, explicit capability.

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
