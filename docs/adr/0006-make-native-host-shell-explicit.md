---
status: superseded by ADR-0010
---

# Make native Host Shell explicit

## Decision

Odyshell names native, same-user shell authority `host.shell` and exposes it only as a separate,
explicit Local Policy and Session Scope choice. It is not part of a generic access preset, cannot
be autoapproved or delegated, and has no compatibility alias for the capability it replaces.

A Host Shell Session approves the machine, objective, duration, and capability rather than an
advance command list. During that Session the Agent may submit independent commands. Each command
starts in the operating-system user's Home by default and runs with all authority available to the
user running the Client, including that user's files, credentials, network, and services. Selecting
a per-command working directory does not narrow this authority. Odyshell does not provide a sandbox,
isolation boundary, persistent terminal, PTY, or shell state between Operations. Commands can make
changes that persist after the Session ends.

Each command inherits an allowlisted base environment rather than every variable held by the
Client process. Explicit environment values apply only to that Operation and are never persisted.
On POSIX, the login shell can still load user startup files under the same-user boundary.

For an installed Linux service, passwordless sudo remains a separate, local opt-in and
`NoNewPrivileges` enforces the disabled setting. Foreground execution has no equivalent service
boundary, so the Client detects effective `sudo -n` and adds a root-escalation warning when
necessary. No equivalent enforcement is promised on macOS or Windows. The root warning never
replaces the same-user Host Shell warning.

## Consequences

- Enrollment, manual Session creation, and approval always disclose the same-user boundary before
  Host Shell authority is granted.
- The Client Profile has no configurable host filesystem root. Relative host work begins in the
  Client user's Home. Docker Profiles keep a Docker-specific mount source.
- Structured process, filesystem, and Docker capabilities remain available for narrower authority.
- Graceful authority loss terminates active process groups. Without a separate Operation
  supervisor, an abrupt Client crash can leave a detached POSIX command running until it exits or
  is stopped externally; restart reconciliation records an unknown result.
- A future isolated shell will use the distinct `sandbox.shell` capability and will become the
  default shell path only when implemented. Escalating from it to Host Shell will require a new
  linked Session with its own explicit approval.

The replacement implementation and review contract is the
[Session control plane](../design/session-control-plane.md).
