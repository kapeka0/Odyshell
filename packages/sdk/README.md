<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell SDK</h1>

<p align="center"><strong>Give TypeScript agents temporary, scoped access to private machines.</strong></p>

`@odyshell/sdk` is the programmatic interface to Odyshell. An Agent Credential identifies the
Agent and requests temporary Sessions; only the claimed Session Credential can execute.

## Install

| Package manager | Command |
| --- | --- |
| pnpm | `pnpm add @odyshell/sdk` |
| npm | `npm install @odyshell/sdk` |
| Yarn | `yarn add @odyshell/sdk` |
| Bun | `bun add @odyshell/sdk` |

```ts
import { Odyshell } from "@odyshell/sdk";

const ods = new Odyshell({
  serverUrl: process.env.ODYSHELL_SERVER_URL!,
  agentToken: process.env.ODYSHELL_AGENT_TOKEN!,
});

const agent = ods.agent({ id: agentId, name: "Dependency auditor" });
const request = await agent.requestOperationSession({
  machineId,
  title: "Inspect repository state",
  purpose: "Inspect repository state",
  durationSeconds: 900,
  action: {
    kind: "process.exec",
    program: "git",
    args: ["status", "--short"],
    cwd: ".",
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

The SDK supports typed process, filesystem, and Docker log Operations plus separately approved
Host Shell authority. Permissions are still enforced by the Server, the Session scope, and the
Client on the target machine.
It does not expose direct runtime Session creation or top-level `process`, `fs`, `docker`, or
`execute` shortcuts: execution starts only from a claimed canonical Agent Session.

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
});
```

When later commands depend on earlier results, request broad Host Shell authority without
anticipating command text:

```ts
const taskRunId = "repair-development-environment-2026-08-05";
const shellRequest = await agent.requestHostShellSession({
  machineId,
  title: "Repair the development environment",
  purpose: "Inspect failures and choose the next command from each result",
  durationSeconds: 3600,
  runId: taskRunId,
});

// Show shellRequest.approvalUrl, wait for approval, then claim once.
const shellClaim = await agent.claim(shellRequest.id, taskRunId);
const shell = ods.claimedSession(shellClaim);
await shell.host.shell({ machineId, command: "node --version" });
await shell.host.shell({ machineId, command: "npm test" });
```

Each command is an independent Operation. It runs natively as the Client's operating-system user,
starts in that user's Home by default, and shares no persistent shell process or state with the
next command. Host Shell has no sandbox or PTY, is limited to host Profiles, and is never
autoapproved or delegated. One unavailable command can fail while the approved Session remains
usable for the next attempt. Keep one stable `runId` for the Task Run and use a new one for
unrelated work. Complete the Session as soon as the overall task succeeds or is abandoned.

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
authority. Requests outside the ceiling still require human approval. Autoapproval and Delegation
Policy scopes cannot contain `host.shell`; every Host Shell request remains manual.

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

Complete a claimed Session when the task finishes and record the Agent-reported outcome:

```ts
await agent.complete(claim.sessionId, "succeeded", "Configuration verified");
```

Completion is rejected while an Operation remains active. Use
`ods.cancelAgentSession(claim.sessionId, agentId)` only to abort active work. Supply a stable
`idempotencyKey` to `claimedSession.execute()` when the caller may retry the same request. Use an
opaque, unique value and reuse it only for the exact same machine, action, requested timeout and
output limit. Odyshell returns `idempotency_conflict` instead of replaying or dispatching when a
retained field differs. A matching retry can redeliver a queued Operation with the same Operation
id only when it has no transport-only input; the Client journal deduplicates it. Host Shell
environment and stdin values are excluded from the persisted fingerprint, while a non-secret
presence bit prevents adding or removing them on retry. Changed transient values passively return
the first Operation and are never dispatched.

Creation atomically reserves a domain-separated hash of the key in a payload-free registry shared
across every machine in the canonical Session. The reservation remains through the control-event
retention window after Operation payload purge, so a late retry fails closed instead of executing
again. If no verifiable Client completion arrives by the Server deadline, the result becomes
`execution_unknown`, not a claimed failure. Never reuse an idempotency key for a logically new
Operation.

Direct Operation cancellation is persisted as `cancellation_requested` before its transport
signal is sent, so the Operation cannot be redelivered during that race. Keep polling that state:
a verified Client completion records the concrete result, while the absolute deadline eventually
converts an unconfirmed cancellation to `execution_unknown`. A machine reconnect also replays any
still-pending cancellation signal.

Use `ods.cancelOperation(operationId)` for the low-level API, or
`ods.claimedSession(claim).cancelOperation(operationId)` to keep the Session Credential scoped to
its own Operations. `SessionClient.createOperation()` and `waitForOperation()` are available when
the caller needs the Operation ID before waiting for its result; `execute()` remains the combined
convenience method.

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

Host Shell renewal additionally supplies the predecessor's stable `runId`. An unattributed manual
Host Shell Session cannot be renewed through the programmatic API.

Prefer `process.exec` with an explicit executable and arguments. For dependent multi-command host
work, request Host Shell authority without including an anticipated command:

```ts
const shellRequest = await agent.requestHostShellSession({
  machineId,
  title: "Diagnose the failing build",
  purpose: "Run dependent diagnostic commands",
  durationSeconds: 3600,
  runId: "diagnose-failing-build-2026-08-05",
});

// After explicit human approval:
const shellClaim = await agent.claim(shellRequest.id);
const shell = ods.claimedSession(shellClaim);
const result = await shell.host.shell({
  machineId,
  command: "npm test && git status --short",
});
```

There is deliberately no top-level `ods.host.shell(...)`: only a claimed Session Credential can
execute Host Shell. Host Shell grants broad authority, requires manual approval, and remains
bounded by Session expiry and the Client Local Policy. Commands run as the Client's
operating-system user with no sandbox or isolation and may persist changes after the Session ends.
The working directory defaults to `.` (the Client user's Home), accepts per-command environment
variables and optional base64 standard input up to 1 MiB, and uses a 600-second timeout plus a 1
MiB output limit by default. Environment values and standard input are transport-only and never
persisted. The process inherits an allowlisted base environment rather than every variable held by
the Client process; on POSIX, the login shell can still load the user's startup files.

Graceful Session closure terminates the active process group. There is no separate Operation
supervisor, so an abrupt Client crash can leave a detached POSIX command running until it exits or
is stopped externally. Restart reconciliation reports that Operation as `execution_unknown`.

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
