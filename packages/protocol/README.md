<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell Protocol</h1>

<p align="center"><strong>The shared contract between the Server, Client, and CLI.</strong></p>

`@odyshell/protocol` contains the TypeScript types and validation rules used across Odyshell. It
defines capabilities, Session requests, typed process, filesystem and Docker Operations, and
messages exchanged between the Server and Client. It also defines the strict Human, Agent, and
task Session identity contracts used by the current authority model.

The current Client wire protocol is v4. It intentionally rejects protocol v3 peers because
recursive `fs.remove` is no longer part of the accepted Operation contract. Update the Server and
Client together; existing Client Profile configuration remains valid and does not require
re-enrollment.

`fs.write` accepts valid standard base64 whose decoded content is at most 1 MiB. `fs.remove`
accepts only non-recursive removal so Clients can bound each mutation to one file or empty
directory.

The `host.shell` capability is intentionally available only to host Client Profiles. Its action
accepts one command, an optional working directory (`.` means the Client Profile home),
per-command environment variables, and up to 1 MiB of base64-encoded standard input. Operation
requests default to a 600-second timeout and 1 MiB of output; the timeout may be requested up to
24 hours and is reduced by the Server to the Session lifetime remaining.

Programmatic Host Shell Session Requests require a stable Task Run `runId`; manual dashboard
Sessions are exempt and are never reused implicitly. A non-zero command result does not close the
Session, so later corrective Operations can continue before explicit task completion. MCP clients
must repeat that `runId` while checking status, executing Operations, completing, and renewing the
Session so unrelated Task Runs cannot consume its authority.

The executor supplies an allowlisted base environment rather than inheriting every Client process
variable. Explicit environment values apply only to that Operation and are never persisted; a
POSIX login shell can still load same-user startup files. Graceful cancellation terminates the
process group, but an abrupt Client crash can leave a detached POSIX command running without a
separate Operation supervisor. Reconciliation reports that result as unknown.

Host Profiles operate from the Client process home and do not configure a filesystem root.
Docker Profiles instead require an explicit `mountSource`. Every Profile defaults to four
concurrent Operations and a local one-hour Operation timeout ceiling.

Protocol v3 is a breaking Client configuration upgrade. Protocol v2 Profiles are not migrated:
remove and re-enroll them. A host Profile must omit the obsolete `workspaceRoot` field and starts
relative work in the operating-system user's Home. A Docker Profile must provide `mountSource`.
Do not copy or hand-edit an old Profile into the v3 shape because re-enrollment also replaces its
local identity and state.

The package keeps both sides aligned without containing transport, authentication, or execution
logic.

## Development

From the monorepo root:

```bash
pnpm --filter @odyshell/protocol build
pnpm test
```

Protocol changes should remain compatible with the current `PROTOCOL_VERSION` or increment the
version when the message contract becomes incompatible.

[Back to Odyshell](../../README.md)
