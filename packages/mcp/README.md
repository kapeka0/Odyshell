<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell MCP</h1>

<p align="center"><strong>One Session workflow for local and remote agent connections.</strong></p>

This private workspace package defines the MCP tools shared by `ods mcp` and the remote OAuth MCP.
Transport and credentials stay in their adapters; this package only translates tool calls into a
trusted runtime interface.

The surface includes machine discovery and ping, Session recovery/status/completion, typed
Operation execution, and Session timelines. It contains no enrollment, member, billing, or
administrator tools. Machine discovery reports an allowlisted platform and local capability
summary without exposing host paths or Client configuration.

When a Session needs human approval, the tool result tells the agent to show the approval link and
wait for the user's decision before checking the request status.
If the MCP client loses a tool response or opens a new chat, `sessions_list` recovers pending
requests and lists active Sessions. Typed authority remains reusable only while the same local MCP
process holds its claim or the same remote installation retains its persistent grant. Host Shell
additionally requires an explicit continuation carrying the same Session Run `runId`; unrelated work
never inherits it.
Request and status results include an explicit `nextAction`, so an agent can resume after human
approval without asking for a duplicate Session.

Local `ods mcp` reuses a compatible ready Session only when that same running process claimed its
Session Credential. The credential remains in memory, is never persisted, and is revalidated
against active Server state before reuse. Restarting the process can recover pending unclaimed
requests, but authority claimed by the previous process requires a new Session request and
approval. Remote MCP instead stores an installation-bound grant in PostgreSQL, so compatible typed
authority remains reusable by that installation across stateless requests and Server restarts.
Compatible Host Shell authority also requires the same stable Session Run `runId`.

The same pending request and review link are available from the Odyshell Sessions dashboard.

Requests can group several exact operations into one least-privilege scope per machine. The MCP
`operation_execute` requires a fresh UUIDv4 `idempotencyKey` for each logical Operation. The MCP client
reuses it only when retrying that exact call; a new call, even with identical action content, uses a
new UUID. This explicit identity is necessary because JSON-RPC request IDs may be reused after a
response and stateless HTTP cannot otherwise distinguish a retry from a later identical call. The
UUID is independent of command text, arguments, file content, environment values, and standard
input, so its retained hash is not a content dictionary oracle. Odyshell also bounds execution time
to the Session lifetime remaining. Completion is rejected while an Operation remains active, and
groups that would create capability-path cross products are rejected.

Filesystem paths may be relative to the Client Home or exact absolute paths on a host
profile. An absolute path is presented and approved as an exact filesystem scope. Docker
profiles reject absolute host paths. Prefer `process.exec` for fully known one-shot work. Use Host
Shell for exploratory, iterative, or multi-command work whose next command depends on results.
`session_request` accepts exactly one authority mode: `operations` retains the exact typed actions
being requested, while `hostShell: { machine }` requests temporary broad Host Shell authority
without guessing future commands and requires a stable Session Run `runId`. A linked escalation can
carry `predecessorSessionId`.
The MCP caller may omit `title`; Odyshell then uses `purpose` as the short approval title or derives
one from the requested authority. The stored Session Request still always has a non-empty title.
Actual `host.shell` commands are supplied only to `operation_execute`; Host Shell is never
autoapproved. `session_status`, `operation_execute`, and `session_complete` repeat the stable
`runId` for attributed Host Shell authority; manual dashboard Sessions are exempt. Persistable
command action fields and output remain temporary delivery data, while
environment values and standard input are transport-only and never persisted. Privacy-minimal
Timeline data and Event Sinks do not export command text or output. Commands run as the Client's
operating-system user, start in that user's Home by default, have no sandbox or isolation, and may
persist changes after the Session ends. The process inherits an allowlisted base environment;
explicit environment values affect only that Operation, while a POSIX login shell can still load
user startup files. Operation execution defaults to 600 seconds and is capped at 24 hours
before the Server reduces it to the Session lifetime remaining. Graceful cancellation stops the
process group, but an abrupt Client crash can leave a detached POSIX command running; the result is
reconciled as unknown.

[MCP documentation](https://odyshell.com/docs/mcp) · [Back to Odyshell](../../README.md)
