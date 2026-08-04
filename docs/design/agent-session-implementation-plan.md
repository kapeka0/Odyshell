# Agent and Session implementation plan

> **Status:** Active implementation plan. The shared Human, Agent, and Session contracts plus the
> additive PostgreSQL expansion and the first remote MCP vertical are implemented. No target Agent
> or Session workflow should be
> presented as shipped until its vertical is tested, deployed, and reflected in public
> documentation.

## Objective

Replace legacy Agent Access with a persistent Agent identity and temporary task-scoped Sessions,
then expose the same model through the canonical API, remote and local MCP, SDK, CLI, Client, and
web application.

The implementation is organized as usable verticals rather than one broad rewrite. The first
vertical must let Claude or Codex connect by OAuth, request a bounded Session, receive browser
approval, perform typed Operations, and produce a Timeline.

## Current-to-target mapping

| Current concept | Target concept | Migration behavior |
| --- | --- | --- |
| Agent Access record | Agent plus Agent Credential | Preserve identity metadata; revoke legacy secret |
| Agent Access machine list | Session targets | Do not migrate as permanent policy |
| Agent Access capability list | Per-machine Session Scope | Do not autoapprove from legacy data |
| Agent Access expiry | Agent Credential expiry | New credential required |
| Single-machine Session | Task Session with multiple targets | Introduce target-level readiness |
| Control Events | Activity plus Session Timeline | Preserve retained legacy events |
| Single client.json | Named Client Profiles | Preserve current identity as the default profile |

The cutover is deliberately fail-closed. Existing Workspaces, people, machines, Client identities,
and retained events survive. Legacy Agent Access credentials and active Sessions do not.

## Target data model

The final schema needs independent records for:

- `agents`: persistent identity, type, parent, status, and Workspace;
- `agent_credentials`: hash, lifecycle, expiry, retirement, and provenance;
- `agent_policies`: self-Session and delegation ceilings with validity;
- `managed_agent_policies`: child-specific subsets of a parent ceiling;
- `session_requests`: required title, optional purpose, requested duration, requester, and decision;
- `sessions`: immutable claimed authority, lifecycle, expiry, predecessor, and reported outcome;
- `session_targets`: machine-specific scope and readiness;
- `session_credentials`: one-time claim hash and revocation state;
- `session_steps`: optional Agent-reported plan and progress;
- `session_events`: verified task lifecycle and Operation events;
- `activity_events`: Workspace-wide security and administrative events;
- `event_sinks`: endpoint, signing configuration, detail level, and delivery state.

Credentials and authorization secrets are never stored in plaintext. Workspace identity must be
part of every unique key, lookup, and relationship that participates in authorization.

## Canonical authorization rules

The Server must reject an Operation unless all conditions hold:

1. the Session Credential is valid, unexpired, unrevoked, and stored only as a hash;
2. the Session is active and belongs to the same Workspace as its Agent and target;
3. the explicit machine appears in a Session Target;
4. the Operation kind maps to a Capability granted by that target;
5. every typed restriction present in the Session allows its path, program, or container;
6. the machine Client Profile is online or can accept the request before timeout;
7. the Client independently accepts the same scope under its Local Policy;
8. the Operation timeout does not exceed the remaining Session lifetime;
9. request and Operation identifiers satisfy replay and idempotency rules.

The Client receives absolute Session expiry and scope. It must reject late Operations and cancel
active process groups at expiry or revocation even if the Server connection is lost.

## Vertical 0: design contract

Deliver:

- target glossary and ADRs;
- protocol schemas for the accepted objects and states;
- a migration compatibility matrix;
- security invariants and abuse cases;
- API and MCP tool names reviewed before implementation.

Exit criteria:

- no target term still depends on Legacy Agent Access;
- all identity and authority transitions have a single owner;
- public current-behavior docs remain unchanged.

## Vertical 1: interactive Claude and Codex

Deliver the smallest complete workflow:

1. remote MCP OAuth creates or restores one Agent per installation;
2. `machines_list` returns machines without granting access;
3. `session_request` accepts a title, optional purpose, duration, and per-machine scopes;
4. an authenticated Member approves or denies through a standalone web route;
5. MCP polls, claims once, and hides the Session Credential;
6. typed tools require explicit Session and machine references;
7. verified Timeline events stream to the dashboard;
8. `session_complete` and expiry close authority.

Defer:

- autoapproval;
- Agent delegation;
- headless Agent registration;
- Event Sinks;
- commercial plan gating.

Exit criteria:

- a user can ask Claude to find a file on a private machine without dashboard preparation beyond
  machine enrollment;
- an approval link contains no credential;
- replaying a claim fails;
- Session expiry cancels a deliberately long-running process;
- the model never sees Agent or Session secrets;
- Timeline distinguishes verified events from Agent-reported outcome.

## Vertical 2: Server and Client enforcement

Deliver:

- multi-machine Sessions with independent target readiness;
- optional filesystem path-prefix constraints and explicit capability-wide grants;
- exact `process.exec` program constraints;
- exact Docker container constraints;
- Client-side Local Policy intersection;
- local expiry timers and process-group cancellation;
- clear denials for offline, locally rejected, expired, revoked, and out-of-scope targets.

Security tests must cover:

- Workspace and target substitution;
- capability and constraint bypass;
- path traversal and symlink escape;
- executable path confusion;
- shell invocation through an allowed executable;
- claim and Operation replay;
- revocation during execution;
- Server disconnect during expiry;
- output or credential leakage into Timeline and errors.

## Vertical 3: adapter parity

Update the TypeScript SDK first, then build all other surfaces on it:

- remote MCP and `ods mcp` expose the same tools;
- CLI separates human, Agent, and Session contexts;
- web calls the same Server API and owns no authorization rules;
- every Operation selects Session and machine explicitly;
- Capability inference remains in shared protocol code.

Remove or hide legacy commands only after replacements exist and migration messaging is ready.

## Vertical 4: fail-closed migration

Status: implemented.

Roll out in this order:

1. deploy additive schema and target APIs;
2. ship compatible Client and CLI versions;
3. deploy MCP and web approval flow;
4. archive Legacy Agent Access records;
5. revoke legacy credentials and active Sessions;
6. require OAuth reconnection or new Independent Agent registration;
7. remove legacy write paths after observing the cutover.

The migration must be atomic per Workspace or resumable with explicit states. Partial migration
must never leave both legacy and target credentials authoritative.

Rollback may restore application code and schema compatibility, but it must not reactivate secrets
that the migration revoked.

## Vertical 5: Independent Agents and autoapproval

Status: implemented.

Deliver:

- `ods agent login` device authorization for headless runtimes;
- 90-day Agent Credential default and one-year maximum;
- bounded-overlap rotation and emergency revocation;
- programmatic Autoapproval Policy requests;
- Admin browser approval;
- 30-day policy default and one-year maximum;
- automatic policy intersection for Session Requests;
- manual fallback for out-of-policy requests.

`host.shell` always follows the manual path and remains separate from structured access presets.

## Vertical 6: Managed Agents

Status: implemented, except future member-driven transfer and promotion.

Deliver:

- one-level parent-child identity relationships;
- parent Delegation Policies;
- child-specific policy subsets;
- Session requests in a Managed Agent's name;
- attribution of executor, requester, and run identifier;
- cascading disable and revocation;
- parent-managed create, list, disable, and delete lifecycle.

Tests must prove that a child cannot:

- create descendants;
- obtain a durable Agent Credential without promotion;
- outlive or exceed the parent's policy;
- act in another Workspace;
- preserve access after the parent is disabled.

## Vertical 7: web model

Add or revise routes:

- Overview canvas with Agent, active Session, and machine nodes;
- Agents table and Agent details;
- Sessions table and Session Timeline;
- Activity table for global security events;
- standalone Agent enrollment, Session approval, and policy approval;
- Workspace Settings for Local Policy visibility and Event Sinks.

UI states must distinguish:

- Agent identity: active or disabled;
- Agent presence: connected or offline;
- Session authority: none, pending, active, or expiring;
- Session target readiness: ready, offline, or rejected.

Skeletons must match each changed page according to `apps/web/UI_RULES.md`.

## Vertical 8: export and Event Sinks

Deliver manual JSON export and signed HTTPS Event Sinks without initial plan gating.

Sink delivery requires:

- minimal, operational, and diagnostic profiles;
- unique event identifiers and at-least-once semantics;
- bounded retry and delivery status;
- signing-secret rotation;
- no authorization headers, credentials, or environment variables;
- HTTPS-only public endpoints;
- private, loopback, link-local, metadata, redirect, and DNS-rebinding defenses;
- response-body and error redaction.

Operational and Diagnostic stdout and stderr can be reconstructed from temporary Operation
delivery data for the Session Timeline. They are not copied into durable Timeline events and
disappear when that temporary data expires. Event Sinks never export command text, stdout, stderr,
environment values, or standard input at any detail level.

## Documentation rollout

After each vertical:

1. update package READMEs for shipped command and API behavior;
2. update public Fumadocs pages only for available features;
3. update `docs/mvp.md` and `docs/privacy.md` when their current claims change;
4. update examples for npm, pnpm, yarn, and bun where installation is shown;
5. remove legacy Agent Access language only after cutover;
6. verify documentation links, builds, and production rendering.

## Release and compatibility

This change breaks the current API, SDK, CLI configuration, MCP tool contract, and Agent token
semantics. It requires an explicit pre-1.0 breaking release with:

- migration notes;
- minimum compatible Client and CLI versions;
- a server cutover window;
- npm publication of updated CLI and SDK packages;
- a GitHub release and tag;
- a production deployment followed by real desktop and Raspberry Pi validation.

No release is complete until denial, expiry, revocation, replay, Workspace isolation, Local Policy,
secret leakage, and migration failure cases pass.
