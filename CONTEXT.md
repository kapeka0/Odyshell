# Odyshell

Odyshell is the controlled execution boundary between AI agents and private machines. This
glossary defines the shipped domain model after the fail-closed Agent Access cutover.

## Human governance

**Organization Member**:
A person who can operate workspace resources, including machines, Agents, Sessions, approvals,
and Activity.
_Avoid_: Viewer, read-only member

**Organization Admin**:
An Organization Member who can additionally govern people, workspace security settings,
autoapproval policies, and delegation policies.
_Avoid_: Superuser, execution admin

**Workspace**:
The isolation boundary containing people, machines, Agents, credentials, Sessions, policies,
Timeline data, and Activity. An operational identity belongs to exactly one Workspace.
_Avoid_: Project, environment, organization

## Agent identity

**Agent**:
A persistent programmatic security identity representing a logical integration or function.
Processes and temporary workers are executions of an Agent, not new Agents.
_Avoid_: Agent Access, process, model instance

**Independent Agent**:
An Agent with its own Agent Credential that can authenticate and request Sessions for itself.
_Avoid_: Service account, permanent access

**Managed Agent**:
An Agent controlled by one Independent Agent and without its own Agent Credential. Its parent
requests Sessions in its name.
_Avoid_: Child process, temporary Agent, nested orchestrator

**Agent Credential**:
A durable, expiring, and revocable proof of Agent identity. It can request authority but never
authorizes machine operations directly.
_Avoid_: Agent token, API access grant, Session Credential

**Agent Presence**:
The recent live connection state of an Agent integration. Presence does not imply permission to
use any machine.
_Avoid_: Agent access, active Session

**Task Run**:
One concrete execution of an Agent task, identified consistently across its retries and explicit
continuations. Unrelated work is a different Task Run even when it uses the same Agent and machine.
_Avoid_: Conversation, model turn, process

## Temporary authority

**Session Request**:
A proposed task containing a purpose, duration, and explicit per-machine Session Scopes. It
becomes a Session only after approval and one-time claim.
_Avoid_: Token request, access token

**Session**:
An immutable, temporary authorization for one Agent task across one or more machines. A Session
is the only source of machine authority for an Agent.
_Avoid_: Agent Access, SSH session, permanent grant

**Session Scope**:
The capabilities and optional typed restrictions granted to one machine within a Session. A
multi-machine Session contains one independent Session Scope per machine.
_Avoid_: Global capabilities, workspace role

**Session Credential**:
A short-lived credential issued when an approved Session is claimed. It can execute only within
that Session and cannot request or delegate further authority.
_Avoid_: Agent Credential, refresh token

**Autoapproval Policy**:
A temporary ceiling under which an Agent can obtain Sessions without a new human approval.
Possessing the policy is not itself an active grant.
_Avoid_: Permanent access, default allow

**Delegation Policy**:
A temporary ceiling that lets an Independent Agent create and govern Managed Agents. Managed
Agent policies and Sessions must remain subsets of this ceiling.
_Avoid_: Administrator role, recursive delegation

## Machine execution

**Client Profile**:
One local Client identity bound to exactly one Server and Workspace, with its own machine identity,
state, and Local Policy. A physical host can run multiple independently configured Client Profiles.
_Avoid_: Global machine identity, shared client.json

**Local Policy**:
The machine-owner-controlled ceiling applied by a Client Profile. Cloud services can observe and
reduce it but cannot expand it remotely.
_Avoid_: Cloud policy, prompt rule

**Capability**:
A named class of typed Operation that must be allowed by both the Session Scope and Local Policy.
_Avoid_: Implicit permission, unrestricted access

**Operation**:
A typed action performed on one machine through an active Session. Its required Capability is
derived from the Operation kind rather than declared by the caller.
_Avoid_: SSH command, unrestricted tool call

**Host Shell**:
An explicitly selected, high-risk Capability that runs independent native shell commands with the
full authority of the operating-system user running the Client, starting each Operation in that
user's Home by default.
_Avoid_: Sandboxed shell, terminal, SSH session

**Machine Enrollment**:
The one-time act of admitting a Client Profile into a Workspace and binding its machine identity.
_Avoid_: Machine login, device login

## Observability

**Session Timeline**:
The task-centric history combining verified system events with optional Agent-reported plans and
outcomes that remain visibly marked as unverified.
_Avoid_: Roadmap, session recording, Agent testimony

**Activity**:
The workspace-wide history of security and administrative changes across people, Agents,
credentials, policies, machines, and Sessions.
_Avoid_: Session Timeline, full audit recording

**Event Sink**:
A Workspace-owned HTTPS destination that receives signed Timeline or Activity events according
to an explicit detail level.
_Avoid_: Odyshell log storage, untrusted callback

## Legacy language

**Legacy Agent Access**:
The pre-migration record that combines Agent identity, credential, machines, capabilities, and
expiry. Use this term only when describing shipped legacy behavior or its fail-closed migration.
_Avoid_: Agent, Session
