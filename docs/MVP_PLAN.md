# Odyshell MVP Plan

Updated: 2026-08-08.

This is the internal working contract for turning Odyshell into a coherent, testable product. It
records accepted product decisions, target architecture, scope, threat model, and delivery state.
Public documentation must continue to describe shipped behavior until a vertical is implemented
and verified.

## Product definition

> Odyshell lets software vendors and MSPs give their AI Agents temporary non-interactive shell
> authority on a customer's real private Linux Machine without sharing SSH credentials, opening
> inbound ports, joining a VPN, or granting permanent access.

The buyer and controller is the customer's infrastructure or security owner. The primary user is
the vendor's Agent. Customer humans establish trust, configure policy, optionally supervise
exceptions, and inspect evidence.

The first job is diagnosing and remediating a Linux service during a bounded Task. The activation
event is the first useful Task completed on a real customer Machine without SSH or VPN access.

## Product principles

- Agent actions use MCP or HTTP; the dashboard is optional governance.
- The Machine owner retains the absolute local policy ceiling.
- Agent identity is durable; Machine authority exists only inside a temporary Task.
- Shell authority is honest same-user authority, not a sandbox or a safe-command claim.
- Cloud and self-hosted use the same code, data model, and protocols.
- Self-hosted operation is sovereign and has no mandatory SaaS dependency.
- The first tested product is intentionally smaller than the current repository.

## MVP workflow

1. An Owner bootstraps an Organization.
2. An Admin registers an external Agent once.
3. The Admin installs a Client Profile under a dedicated Linux user and selects that Agent for its
   Local Policy.
4. The Client establishes an authenticated outbound connection and advertises the Local Policy.
5. The Agent requests one Task for one Machine and operating-system user.
6. The Task autoapproves inside policy or waits for optional Supervisor approval.
7. The Agent submits asynchronous non-interactive Commands and reads bounded results.
8. The Agent completes the Task, or a human revokes it, or it expires.
9. Humans and the Agent can inspect attributable audit evidence.

## Scope classification

### KEEP

- outbound authenticated Client connection and Ed25519 Machine identity;
- PostgreSQL persistence and Kysely database access;
- single-use expiring Machine Enrollment;
- durable Agent identity separated from temporary authority;
- local-policy enforcement, heartbeat, reconnect, cancellation, and idempotency foundations;
- Fastify Server, Next.js Web, Zod contracts, and remote MCP transport;
- process-group termination and bounded output foundations.

### SIMPLIFY

- Organization becomes the only isolation owner; Workspace disappears;
- Session becomes one-Machine Task;
- Operation becomes asynchronous shell-only Command;
- Autoapproval becomes Autonomy Policy with no command filters;
- Activity and Session Timeline become Audit Event and Task Timeline;
- CLI becomes installation, diagnostics, updates, and local recovery only;
- Web becomes onboarding, Machines, Agents, policies, Tasks, audit, and settings only;
- Cloud and self-hosted configuration converge on the same identity module.

### REMOVE

- Clerk and every Clerk-specific identity adapter;
- typed filesystem, structured process, Docker logs, and Docker execution profiles;
- multi-Machine Sessions, renewal chains, Task Runs, Managed Agents, and delegation policies;
- SDK as a supported public package and local stdio MCP;
- caller-supplied environment and stdin;
- terminal, PTY, VPN, port forwarding, network access, command filtering, and rollback claims;
- macOS and Windows Client support and their background-service implementations;
- Workspace switchers, dual Organization/Workspace ownership, and obsolete UI;
- Event Sinks, rich workspace canvas, and other non-essential management breadth;
- non-Linux CLI distribution and implicit compatibility migration.

### BUILD NOW

- Better Auth backed by the same PostgreSQL database;
- local email/password, optional generic OIDC, optional Cloud Google OAuth;
- Owner, Admin, and Supervisor authorization;
- OAuth Authorization Code + PKCE and Client Credentials for Agents;
- Task/Command schema, lifecycle, canonical HTTP module, and remote MCP adapter;
- exact-command audit with output retention off by default;
- Linux glibc/systemd process supervision for x86_64 and ARM64;
- the Linux npm `ods` package, explicit Client updates, and uninstall/recovery;
- sovereign single-Organization Compose deployment;
- minimal dashboard, onboarding, example integration, and critical E2E coverage.

### POST-MVP

- Stripe, checkout, portal, and automated plan enforcement;
- exact Cloud price, Enterprise plan, SSO provisioning, SCIM, SIEM, and compliance claims;
- terminal, private networking, multiple Machines per Task, or new Client platforms;
- secret injection, retained output by default, immutable audit, end-to-end signatures against a
  compromised Server, HA, scheduling, and runbooks;
- public SDK, local MCP, Agent delegation, and orchestration;
- the final marketing landing until shipped product and pricing are stable.

## Target modules and seams

| Module | Interface | Adapters |
| --- | --- | --- |
| Identity | authenticate humans and Agents; resolve Organization principal and role | Better Auth web/OIDC and OAuth token endpoints |
| Authorization | evaluate Local Policy, Autonomy Policy, human approval, Task state, and role | PostgreSQL repository and in-memory test repository |
| Execution | submit/cancel/reconcile one Command and return bounded state | WebSocket Client adapter and in-memory fake Client |
| Audit | append/query redacted Organization and Task evidence | PostgreSQL repository |
| Agent protocol | discover Machines and manage Tasks/Commands | canonical HTTP and remote MCP adapters |

Callers must not reproduce tenant, policy, expiry, or revocation checks. Those checks belong behind
the Authorization module's interface so HTTP, MCP, Web, and tests exercise the same implementation.

## Threat model

| Threat | MVP control | Residual risk stated explicitly |
| --- | --- | --- |
| Compromised Agent | Organization binding, OAuth expiry/revocation, policy, Task TTL, concurrency | Can do anything allowed to the selected OS user during policy authority |
| Stolen token | short access lifetime, rotation, hashed durable secrets, revocation, rate limits | Bearer access token can be replayed until expiry unless later proof-of-possession is added |
| Malicious human | roles, Local Policy ceiling, Audit Events | Owner/Admin legitimately control broad Organization policy |
| Malicious Organization | tenant keys on every resource and query | Shared infrastructure remains a trusted implementation |
| Compromised Server | Local Policy enforced by Client | Can abuse authority already allowed by Local Policy |
| Compromised Client | Machine identity and result attribution | Can falsify output and act with its local OS user independently of Odyshell |
| Replay | one-time enrollment, idempotency keys, immutable request binding, expiry | Replays inside an unexpired bearer-token window remain possible without PoP |
| Confused deputy | explicit Organization/Agent/Task/Machine binding at the authorization seam | No cross-Organization delegation exists |
| Privilege escalation | pre-existing dedicated OS user; Odyshell never configures sudo | Same-user credentials, network, and services remain accessible |
| Command injection | raw command is the intended payload; no string interpolation by Server | The Agent deliberately receives arbitrary shell within granted authority |
| Secret leakage | no Agent env/stdin, no credentials in audit, output retention off | Commands can still read and print Machine-local secrets |
| Late execution | Task expiry, revocation signal, systemd process scope, reconnect reconciliation | Completed side effects cannot be rolled back |

Every affected implementation increment must include success, denial, expiry, revocation, replay,
cross-Organization, bounds, and secret-leakage tests proportional to its trust surface.

## Deployment and licensing

- Server and Web target AGPL-3.0; Client, CLI, and protocol target Apache-2.0. Final license text is
  subject to legal review before public release.
- Self-hosted boots one Organization and works without Cloud, external identity, telemetry, relay,
  or license service.
- Cloud hosts multiple Organizations using the same binaries and schema.
- The future Cloud unit is active connected Machine. Agents, humans, and Commands are unmetered.

## External resources needed later

No external credential blocks local implementation or verification. Before production Cloud launch,
the Owner will need to provide or approve in one batch:

- production domain and DNS control;
- production PostgreSQL and compute/deployment access;
- Google OAuth application credentials if Google login is enabled;
- outbound email provider credentials for verification and recovery if Cloud requires email;
- artifact-signing identity and release-hosting destination;
- Stripe credentials only when billing moves out of POST-MVP;
- final legal approval of AGPL-3.0/Apache-2.0 licensing and privacy/terms text.

No package, release, DNS, deployment, or payment action will be performed without explicit release
authorization.

## Delivery state

### DONE

- repository and public-market research captured in `docs/research/odyshell-product-market.md`;
- agent-native product direction and first ICP accepted;
- sovereign self-hosting, identity replacement, domain, scope, trust, licensing direction,
  monetization unit, and visual reference resolved through grilling;
- target Task/Command architecture recorded in `docs/design/agentic-task-model.md`.
- sovereign Odyshell Identity replaces Clerk with local password auth, Organization roles, OAuth
  Agent grants, PostgreSQL persistence, and a self-hosted Compose path;
- the agent-native Task/Command protocol, Local Policy ceiling, centralized authorization service,
  idempotency semantics, exact-command audit contract, and isolated PostgreSQL repository exist
  with focused denial tests.
- canonical OAuth HTTP Task/Command routes, Client Profile policy negotiation, outbound Task and
  Command transport, bounded transient output, cancellation, expiry, process-tree reuse, and
  PostgreSQL integration tests are implemented; the self-hosted Server boots these migrations.
- remote OAuth MCP now exposes only Machine discovery and the resumable Task/Command lifecycle,
  using the same authorization service and Organization-bound Agent identity as canonical HTTP.
- Client reconnect now reconciles opening and active Tasks, queued or running Commands, pending
  cancellation, and expiry without duplicating journaled execution; expiry remains pending until
  the Client confirms local authority closure.
- Owner, Admin, and Supervisor identities can list, approve, or deny Organization-bound Tasks
  through the trusted web boundary; approval delivery survives an offline Client and is audited.
- the dashboard exposes the same Task lifecycle as the agent protocols, prioritizes Tasks that
  require a human decision, confirms authority-changing actions, and keeps recent Task state
  observable without making human supervision mandatory.
- the CLI no longer exposes the superseded local stdio MCP authorization path; Agents use the
  remote OAuth MCP adapter or canonical HTTP interface backed by the same Task/Command module.
- Machine enrollment now binds a sovereign Organization ID and selected Agent into a conservative
  Task Local Policy before starting the outbound Linux Client; missing identity fails before the
  one-time token is consumed.
- the published Linux CLI is now Machine-side installation and diagnostics only; Human login,
  Agent runtime, Session/Operation, typed filesystem, Docker, sudo configuration, and local MCP
  command paths were removed instead of preserved as compatibility layers.
- the public Web surface is now Task-native: legacy Session/Operation approval, Timeline, Event
  Sink, legacy policy, SDK, migration, and rich overview routes were removed; Tasks are the
  dashboard entrypoint and Activity reads exact-command Task audit without retained output.
- the superseded public TypeScript SDK was removed from the workspace and coordinated release;
  Agents integrate through canonical HTTP or its remote OAuth MCP adapter.
- Docker execution Profiles and their local runner were removed; the Machine Client now advertises
  only native Linux host execution.
- the production Server now mounts only Task/Command agent routes, Task supervision, enrollment,
  Machine governance, Agent revocation, OAuth, remote MCP, live dashboard state, and health; legacy
  Session/Operation, device activation, Agent Access, delegation, Event Sink, and policy endpoints
  are no longer reachable.
- Machine governance in Web is metadata and revocation only; remote capability widening and the
  obsolete browser/device activation flows were deleted, leaving Local Policy Machine-owned.
- the Linux Client now executes Task/Command directly: its strict configuration, SQLite Command
  journal, reconnect buffer, expiry, cancellation, process-tree termination, and shell executor no
  longer contain Session adapters, typed filesystem actions, Docker actions, caller env/stdin,
  multi-platform services, remote sudo configuration, or executor capability profiles.

### DOING

- remove superseded Session/Operation protocol and persistence code, Workspace ownership, Managed
  Agent delegation, and Event Sink implementations after the replacement vertical works.

### BLOCKED

- none for local implementation.

### POST-MVP

- validation process and thresholds are intentionally not fixed yet;
- Stripe and exact pricing;
- public artifact publication and production deployment.

## Verification gates

Each vertical must pass its focused security tests plus repository typecheck, lint where available,
and build. The final MVP gate additionally requires:

- human authentication and role denial E2E;
- Organization isolation and cross-tenant denial;
- Agent OAuth expiry and revocation;
- one-time Machine Enrollment and replay denial;
- Agent to Server to Client Task/Command execution on supported Linux;
- reconnect, idempotency, failed Command, timeout, cancellation, Task revocation, and process-tree
  termination;
- exact-command audit without credential or output leakage;
- self-hosted bootstrap with no external SaaS dependency;
- install, update, uninstall, and recovery documentation;
- `test`, `typecheck`, `lint`, `build`, docs checks, and secret scan all passing.
