# Agent and Session model

> **Status:** Accepted product and architecture design. Typed, multi-machine Session Scopes are
> implemented for filesystem, structured process execution, and Docker logs. The signed-in MCP
> convenience flow currently requests one exact `fs.read`.
>
> Policy automation, delegation, renewal, and headless Agent Credentials remain target design.

## Goal

Odyshell lets programmatic Agents perform bounded tasks on real private machines without SSH
credentials, inbound ports, private-LAN access, a VPN, or a full coding Agent installed on every
target.

The Web application is an approval, configuration, observability, and recovery surface. It is not
a required hop for normal programmatic operation. Agents use the canonical API through MCP, SDK,
or CLI.

## Core model

An Agent is persistent. Authority is temporary.

```mermaid
flowchart LR
    H["Workspace Member"] -->|"Approves"| R["Session Request"]
    A["Agent identity"] -->|"Requests"| R
    R -->|"Claim once"| S["Temporary Session"]
    S --> T1["Machine scope A"]
    S --> T2["Machine scope B"]
    T1 -->|"Typed operations"| M1["Private machine A"]
    T2 -->|"Typed operations"| M2["Private machine B"]
    M1 --> E["Session Timeline"]
    M2 --> E
```

The legacy model attaches machines, capabilities, expiry, and a bearer credential to one Agent
Access record. The accepted model separates four concerns:

| Concern | Domain object |
| --- | --- |
| Durable programmatic identity | Agent |
| Proof of that identity | Agent Credential |
| Temporary task authority | Session |
| Proof of active task authority | Session Credential |

Registering an Agent never grants machine access. A Session is the only source of authority for
Agent Operations.

## Agents

An Agent represents a logical security principal, such as `Claude — Karim desktop`, `OpenClaw`,
`Dependency updater`, or `Log investigator`. It does not represent every model invocation,
process, subagent, or task.

### Independent Agents

An Independent Agent has an Agent Credential and can authenticate and request Sessions for
itself. It can become an orchestrator only through a separately approved Delegation Policy.

Agent Credentials:

- prove identity but never execute Operations;
- last 90 days by default and at most one year in Odyshell Cloud;
- offer 30-day, 90-day, 6-month, and 1-year durations;
- are returned only to the trusted runtime and stored hashed by the Server;
- can be rotated with at most ten minutes of overlap;
- cannot be reissued by the Agent for itself.

OAuth integrations follow the identity provider's access and refresh lifecycle. Revoking an OAuth
installation invalidates the corresponding Agent identity credential.

### Managed Agents

A Managed Agent is a persistent identity owned by one Independent Agent. It has no Agent
Credential; its parent requests Sessions in its name and gives workers only Session Credentials.

Delegation has one level:

```text
Independent Agent
├── Managed Agent
├── Managed Agent
└── Managed Agent
```

A Managed Agent cannot create descendants. A Workspace Member can transfer it, promote it to an
Independent Agent, disable it, or delete it.

Disabling or revoking a parent:

- disables its Managed Agents;
- revokes their active Sessions;
- cancels their active Operations;
- preserves identities and Timelines for audit or transfer.

## Session Requests

A Session Request contains:

- the Agent that will execute;
- the Agent or human that requested it;
- a required short purpose;
- an optional structured plan;
- requested duration;
- one or more per-machine Session Scopes.

Purpose and plan are untrusted Agent-provided context. They help a human understand the request
and build the Timeline, but they never participate in authorization.

A request outside an active Autoapproval Policy remains pending. `session_request` returns
immediately with a request identifier, an approval URL, and an expiry instead of blocking a tool
call. The Agent checks it later with `session_status`.

The request can be approved or denied, but not partially edited. If the requester needs different
authority, it creates a new request.

### Approval and claim

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Approved: Member approves
    Pending --> Denied: Member denies
    Pending --> Expired: 10 minute request window
    Approved --> Active: Agent claims once
    Approved --> Expired: 5 minute claim window
    Active --> Completed: Agent completes
    Active --> Cancelled: Agent cancels
    Active --> Revoked: Member or policy revokes
    Active --> Expired: Session TTL ends
```

Session duration begins at claim, not approval or first Operation. MCP claims and stores the
Session Credential internally so the model never sees it. API and SDK orchestrators can receive
the credential once and inject it into a trusted worker.

## Sessions

A Session is an immutable authorization for one task. It can target multiple machines, but every
machine has an independent scope and readiness state.

```ts
type Session = {
  agentId: string;
  purpose: string;
  expiresAt: string;
  targets: Array<{
    machineId: string;
    capabilities: string[];
    restrictions: {
      filesystem?: {
        paths: Array<{ path: string; includeDescendants: boolean }>;
      };
      process?: {
        programs: Array<{
          program: string;
          args: string[];
          cwd: { path: string; includeDescendants: boolean };
        }>;
      };
      docker?: {
        containers: string[];
      };
    };
  }>;
};
```

Typed restrictions are required whenever their corresponding capability is present:

- filesystem capabilities accept exact normalized paths or explicit descendant trees;
- `process.exec` accepts an exact program, argument array, and working-directory restriction;
- `docker.logs` accepts exact container names;
- initial policy does not use regular expressions;
- unknown or malformed restrictions fail closed.

`process.shell` cannot be constrained reliably and is not available in a restricted Agent Session.

### Duration and renewal

Session presets are 15 minutes, 1 hour, 4 hours, 8 hours, and 24 hours. The default is one hour,
the maximum is 24 hours, and no Session can be permanent.

An active Session is never extended or widened. `renew` creates a successor Session with a new
identifier, approval decision, and credential. It can preserve or reduce scope; expanding
authority is a new request.

### Per-target readiness

Approval is atomic, but readiness is independent:

```text
Session: Active

desktop       Ready
raspberry-pi  Offline
production    Rejected by Local Policy
```

An offline or rejected target does not block available targets. A target that reconnects before
Session expiry can become ready. Odyshell never reduces requested scope silently to make a target
work.

### Completion and cancellation

`session_complete` requires no active Operations. Odyshell records verified lifecycle and
Operation results; the Agent may report `succeeded` or `failed` with an optional summary, which is
visibly marked as Agent-reported.

`session_cancel`, expiry, and security revocation cancel active Operations. The Client enforces
the deadline locally even when disconnected from the Server, and process execution must terminate
the process group so children cannot survive the Session.

## Authorization

The effective authority for an Operation is the intersection of independent boundaries:

```text
Workspace isolation
∩ Agent or Managed Agent policy
∩ Session Scope for the selected machine
∩ Session lifetime and status
∩ Client Local Policy
∩ typed Operation validation
```

Every Operation references an explicit Session and machine. Odyshell derives the required
Capability from the Operation kind:

```text
filesystem_read → fs.read
process_exec    → process.exec
docker_logs     → docker.logs
```

The caller never repeats a capability list during execution.

## Policies

### Autoapproval Policy

An Autoapproval Policy defines Sessions that an Agent can claim without a new human decision. It
does not create an active grant.

Defaults:

- 30 days validity;
- selectable validity of 1 day, 7 days, 30 days, 90 days, or 1 year;
- maximum one year;
- no permanent option.

Any request exceeding the policy becomes pending for human approval. The Server never partially
autoapproves it.

### Delegation Policy

A Delegation Policy lets an Independent Agent create Managed Agents and assign their policies
without repeated approvals. It defines:

- maximum Managed Agent count;
- per-machine maximum capabilities and restrictions;
- maximum Session duration;
- policy validity.

Every Managed Agent policy must be a subset of its parent's Delegation Policy and cannot outlive
it. The effective authority is:

```text
Parent Delegation Policy
∩ Managed Agent Policy
∩ Session Scope
∩ Client Local Policy
```

An Agent can propose policies through MCP or API. An Organization Admin approves them through a
standalone browser route. The Agent cannot edit or approve its own ceiling.

## Credentials

### Session Credentials

A claimed Session returns a one-time Session Credential:

- the Server stores only its hash;
- it expires exactly with the Session;
- it cannot request, renew, or delegate authority;
- it is never placed in URLs, Timeline events, Activity, logs, or documentation;
- MCP keeps it outside model-visible tool results.

### Agent Credential lifecycle

Normal rotation and emergency revocation are different operations:

| Transition | New Session Requests | Existing Sessions |
| --- | --- | --- |
| Active | Allowed | Continue |
| Retiring | Denied after overlap | Continue |
| Expired | Denied | Continue |
| Revoked | Denied immediately | Sessions issued by it are revoked |
| Agent disabled | Denied | All Agent and descendant Sessions are revoked |

## Machine boundary

A physical host can run several Client Profiles, but each Client Profile belongs to exactly one
Server and Workspace and has an independent identity, root, and Local Policy.

```text
Physical desktop
├── personal profile → Odyshell Cloud / personal Workspace
└── company profile  → self-hosted Server / production Workspace
```

The Local Policy can be observed and narrowed remotely, but it can only be expanded through a
local machine action. A compromised Cloud account therefore cannot widen filesystem roots,
capabilities, programs, or containers.

## MCP, API, SDK, CLI, and web

The Server API is canonical. MCP, SDK, CLI, and web are adapters and do not contain independent
authorization behavior.

### MCP

Odyshell Cloud provides one remote OAuth-authenticated MCP. `ods mcp` provides the same tools for
self-hosting and local integrations.

The MCP surface includes:

- identity and Managed Agent tools;
- Session request, status, renewal, completion, cancellation, and listing;
- machine discovery and ping;
- typed process, filesystem, and Docker Operations;
- Session Timeline tools.

Human membership, billing, and unrestricted Workspace administration are not MCP tools.

### CLI

Human OAuth, Agent identity, and Session execution are separate contexts:

- human login enrolls machines, manages Agents, approves Sessions, and views Activity;
- Agent credentials request Sessions;
- Session credentials execute Operations.

A human test command still runs through an Agent and Session. Human credentials never bypass the
Agent authorization model.

Independent headless Agents use device authorization:

```text
ods agent login

Open https://odyshell.com/activate-agent?code=ABCD-EFGH
```

Approval registers the Agent and delivers its Agent Credential to the runtime without granting
machine access.

### Web

The web application provides:

- standalone OAuth, Agent enrollment, Session approval, and policy approval routes;
- Agents, Machines, Sessions, Activity, and Settings pages;
- recovery, policy configuration, and credential revocation;
- a real-time Overview canvas.

The canvas treats identity, presence, and access as different states. Active Sessions appear as
temporary nodes between Agents and machines. Selecting a Session opens its Timeline.

## Timeline and privacy

Each Session Timeline combines two visibly different sources:

1. verified Server and Client events;
2. optional Agent-provided plan, progress, outcome, and summary.

Privacy-minimal is the default. It retains Agent, machine, Operation kind, status, duration, and
timestamps without command text, arguments, paths, file contents, stdout, or stderr.

Retention defaults:

| Data | Retention |
| --- | --- |
| Verified Timeline | 30 days |
| Agent purpose and plan | 30 days |
| Temporary Operation payload | At most 1 hour |
| stdout and stderr | Not persisted by default |

Activity remains separate from Sessions. Sessions answer what task an Agent performed; Activity
answers what security or administrative changes occurred across the Workspace.

Event Sinks can select:

- `minimal`: identifiers, targets, Operation kinds, results, and times;
- `operational`: programs, arguments, paths, and containers;
- `diagnostic`: live stdout and stderr without Odyshell persistence.

Credentials, authorization headers, and environment variables are never sent. Sink endpoints are
configured in Workspace Settings, receive signed events, and must be protected against private
network targets and other SSRF destinations. Feature availability by commercial plan is deferred
until the workflow is validated.

## Workspace isolation

Agent identities, credentials, policies, Sessions, and machines belong to one Workspace. A vendor
operating across customers uses an independent Agent installation per customer Workspace. No
Session or operational credential crosses Workspaces.

## Primary use cases

### Interactive Claude or Codex

1. The user adds the remote Odyshell MCP.
2. OAuth registers one persistent Agent for that installation.
3. The Agent requests a 15-minute read Session on `desktop`.
4. A Member reviews and approves the exact scopes in a browser.
5. MCP claims the Session without exposing its credential to the model.
6. The Agent searches and reads files through typed Operations.
7. The Session Timeline updates in real time.
8. The Agent reports completion and the Session closes.

This is the first end-to-end implementation target.

### Autonomous OpenClaw

1. OpenClaw registers as an Independent Agent through device authorization.
2. It proposes a 30-day Autoapproval Policy.
3. An Admin approves exact machines, restrictions, and a one-hour Session maximum.
4. OpenClaw requests short Sessions whenever it has work.
5. Requests inside the policy autoapprove; requests outside it require a human.
6. Every task remains a separate Session and Timeline.

### Delegated multiagent work

1. Claude receives a time-limited Delegation Policy.
2. Claude creates `Dependency updater` as a Managed Agent.
3. It assigns a smaller policy within the approved ceiling.
4. Claude requests a Session for the Managed Agent.
5. A worker receives only the Session Credential.
6. Timeline attribution records the Managed Agent, the requesting Claude Agent, and the run
   identifier.

### B2B customer installation

A vendor maintains one Agent installation per customer Workspace. The customer retains the Local
Policy on every machine, approves delegation ceilings, owns Timeline and Activity data, and can
revoke only its installation without affecting other customers.

## Explicit non-goals

- permanent Sessions;
- recursive Agent delegation;
- cross-Workspace Agent credentials or Sessions;
- remotely expanding Local Policy;
- implicit Session selection;
- capabilities supplied by the caller at Operation time;
- autoapproving `process.shell`;
- treating Agent-reported summaries as verified facts;
- storing full session content by default;
- deciding commercial plan boundaries before usage is validated.
