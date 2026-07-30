# Odyshell

Odyshell is the controlled execution boundary between AI agents and private machines. This
glossary names the product concepts shared by the Cloud service, CLI, Server, and Client.

## Language

**Organization Member**:
A person who can operate every workspace resource in their organization, including machines,
Agent Access, and Control Events.
_Avoid_: Read-only member, viewer

**Organization Admin**:
An Organization Member who can additionally govern people and organization-level settings.
_Avoid_: Superuser, execution admin

**Web Control Plane**:
The human administration surface for an Odyshell Cloud organization. It manages machine
enrollment, Agent Access, and Control Events.
_Avoid_: Dashboard, web app, admin panel

**Agent Access**:
A temporary authorization bounded to a workspace, selected machines, allowed capabilities, and
an expiry time. It can authorize repeated operations until it expires or is revoked, but it can
never be permanent.
_Avoid_: Agent token, permanent access, SSH access

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
