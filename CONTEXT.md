# Odyshell

Odyshell is the controlled execution boundary between AI agents and private machines. This
glossary names the product concepts shared by the Cloud service, CLI, Server, and Client.

## Language

**Organization Member**:
A person who can operate every workspace resource in their organization, including machines,
Agents, Agent Credentials, and Control Events.
_Avoid_: Read-only member, viewer

**Organization Admin**:
An Organization Member who can additionally govern people, organization settings, and workspace
security settings. Other members may view those settings but cannot change them.
_Avoid_: Superuser, execution admin

**Workspace**:
The visible resource boundary containing machines, Agents, Active Connections, and Control Events.
The MVP exposes one Workspace per organization.
_Avoid_: Project, environment, organization

**Web Control Plane**:
The human administration surface for an Odyshell Cloud Workspace. It manages machine enrollment,
Agents, Agent Credentials, and Control Events.
_Avoid_: Dashboard, web app, admin panel

**Agent**:
A durable programmatic identity in a Workspace. It keeps its name, selected machines, and allowed
capabilities until it is deleted.
_Avoid_: Agent token, temporary access

**Agent Credential**:
A temporary secret issued for an Agent. It expires or can be revoked without deleting the Agent
or changing its policy. An Agent has at most one active credential; renewing rotates it immediately
while preserving configuration, and every expiry or revocation ends its existing sessions.
_Avoid_: Agent, permanent key, SSH credential

**Active Connection**:
The live relationship created while an Agent is using a temporary session or operation on a
machine. A valid but idle Agent Credential is not an Active Connection, and rotating its
credential, revoking it, or reaching its expiry ends the Agent's existing sessions.
_Avoid_: Agent permission, available access

**Capability**:
A named class of operation that must be explicitly included in an Agent policy and allowed by the
target machine.
_Avoid_: Implicit permission, unrestricted access

**Control Event**:
A privacy-minimal record that an administrative or agent action occurred, without recording
command output or file contents.
_Avoid_: Session recording, activity recording, full audit log

**Machine Enrollment**:
The one-time act of admitting a machine Client into a workspace.
_Avoid_: Machine login, device login
