# Odyshell

Odyshell is the controlled execution boundary between external AI agents and real private
machines. This glossary defines the accepted agent-native domain language.

## Human governance

**Organization**:
The isolation boundary that owns people, machines, Agents, policies, Tasks, Commands, credentials,
and Audit Events. An identity or operational resource belongs to exactly one Organization.
_Avoid_: Workspace, project, tenant

**Owner**:
A person who controls Organization identity, ownership, and irreversible Organization actions.
_Avoid_: Superuser, root user

**Admin**:
A person who enrolls machines and Agents and configures Organization policies.
_Avoid_: Organization Member, execution admin

**Supervisor**:
A person who can approve or revoke Tasks and inspect Audit Events without expanding policy.
_Avoid_: Viewer, operator, approver

## Agent identity

**Agent**:
A persistent programmatic security identity representing one external integration in one
Organization. Internal processes and subagents share that identity unless registered separately.
_Avoid_: Service account, model instance, Managed Agent

**Agent Credential**:
A rotatable and revocable proof of Agent identity that can request Tasks but cannot execute a
Command without Task authority.
_Avoid_: API key, permanent access, Task Credential

## Machine authority

**Machine**:
One enrolled private host represented by one Client Profile in one Organization.
_Avoid_: Node, target, device

**Client Profile**:
One local Client identity bound to exactly one Server, Organization, Machine, and operating-system
user. A physical host can run multiple independently configured Client Profiles.
_Avoid_: Global machine identity, shared client configuration

**Local Policy**:
The machine-owner-controlled absolute resource ceiling enforced by a Client Profile. It belongs
to one Organization and never names an Agent; Agent-to-Machine authority exists only in a Task.
_Avoid_: Cloud policy, prompt rule, command filter

**Autonomy Policy**:
An Organization-approved ceiling under which an Agent can obtain Tasks without a new human
approval. It is not itself active machine authority.
_Avoid_: Autoapproval Policy, permanent access, role

## Agent work

**Task Request**:
A proposal from an Agent for temporary authority on one Machine as one operating-system user.
_Avoid_: Session Request, token request

**Task**:
An immutable, temporary authorization for one Agent to perform one bounded job on one Machine as
one operating-system user. A Task is the only source of Command authority.
_Avoid_: Session, terminal, SSH session, grant

**Task Credential**:
A short-lived proof of active Task authority that cannot request or delegate another Task.
_Avoid_: Session Credential, Agent Credential, refresh token

**Command**:
One asynchronous, non-interactive native shell execution performed through an active Task.
_Avoid_: Operation, action, terminal command

## Evidence

**Task Timeline**:
The task-centric history of verified requests, decisions, Commands, cancellation, expiry, and
results.
_Avoid_: Session Timeline, session recording, Agent testimony

**Audit Event**:
An Organization-wide record of a security, administrative, or execution lifecycle change.
_Avoid_: Activity, application log, Task Timeline
