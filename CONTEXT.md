# Odyshell

Odyshell is the controlled execution boundary between AI agents and private machines. This
glossary names the product concepts shared by the Cloud service, CLI, Server, and Client.

## Language

**Organization Member**:
A person who can operate every workspace resource in their organization, including machines,
Agent Access, and Control Events.
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
Agent Access, and Control Events.
_Avoid_: Dashboard, web app, admin panel

**Agent Access**:
A temporary authorization bounded to a workspace, selected machines, allowed capabilities, and
an expiry time. It can authorize repeated operations until it expires or is revoked, but it can
never be permanent.
_Avoid_: Agent token, permanent access, SSH access

**Agent**:
A programmatic client represented in the MVP by one temporary Agent Access. It is not yet a
durable identity that can hold multiple authorizations.
_Avoid_: Permanent agent account, service account

**Active Connection**:
The live relationship created while an Agent is using a temporary session or operation on a
machine. A valid but idle Agent Access is not an Active Connection.
_Avoid_: Agent permission, available access

**Capability**:
A named class of operation that must be explicitly included in Agent Access and allowed by the
target machine.
_Avoid_: Implicit permission, unrestricted access

**Control Event**:
A privacy-minimal record that an administrative or agent action occurred, without recording
command output or file contents.
_Avoid_: Session recording, activity recording, full audit log

**Machine Enrollment**:
The one-time act of admitting a machine Client into a workspace.
_Avoid_: Machine login, device login
