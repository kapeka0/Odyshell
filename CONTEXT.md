# Odyshell

Odyshell is the controlled execution boundary between external AI agents and real private
machines. This glossary defines the accepted agent-native domain language.

## Human governance

**Organization**:
The isolation boundary that owns people, machines, Agents, policies, Sessions, Commands, credentials,
and Audit Events. An identity or operational resource belongs to exactly one Organization.
_Avoid_: Workspace, project, tenant

**Owner**:
A person who controls Organization identity, ownership, and irreversible Organization actions.
_Avoid_: Superuser, root user

**Admin**:
A person who enrolls machines and Agents and configures Organization policies.
_Avoid_: Organization Member, execution admin

**Supervisor**:
A person who can approve or revoke Sessions and inspect Audit Events without expanding policy.
_Avoid_: Viewer, operator, approver

## Agent identity

**Agent**:
A persistent programmatic security identity representing one external integration in one
Organization. Internal processes and subagents share that identity unless registered separately.
_Avoid_: Service account, model instance, Managed Agent

**Agent Role**:
The Organization-assigned authority class of an Agent. A Standard Agent needs a Human decision for
every Session; an Operator Agent may obtain Sessions without a new Human decision.
_Avoid_: Human role, Autonomy Policy

**Operator**:
An Agent Role that permits an Agent to obtain temporary Sessions without explicit Human approval.
It does not create permanent Machine authority or widen a Machine's Local Policy.
_Avoid_: Human operator, superuser, unrestricted Agent

**Agent Credential**:
A rotatable and revocable proof of Agent identity that can request Sessions but cannot execute a
Command without active Session authority.
_Avoid_: API key, permanent access, Session Credential

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
to one Organization and never names an Agent; Agent-to-Machine authority exists only in a Session.
_Avoid_: Cloud policy, prompt rule, command filter

## Agent work

**Session Request**:
A proposal from an Agent for temporary authority on one Machine as one operating-system user.
_Avoid_: Session Request, token request

**Session**:
An immutable, temporary authorization for one Agent to use a shell on one Machine as one
operating-system user. A Session is the only source of Command authority.
_Avoid_: Session, terminal, SSH connection, grant

**Command**:
One asynchronous, non-interactive native shell execution performed through an active Session.
_Avoid_: Operation, action, terminal command

## Evidence

**Session Timeline**:
The Session-centric history of verified requests, decisions, Commands, output, cancellation, expiry, and
results.
_Avoid_: Session Timeline, Agent testimony

**Audit Event**:
An Organization-wide record of a security, administrative, or execution lifecycle change.
_Avoid_: Activity, application log, Session Timeline
