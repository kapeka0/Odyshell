# Host Shell

Status: accepted.

This document is the implementation and review specification for native shell authority. It
separates the shipped `host.shell` capability from the planned `sandbox.shell` capability so that
the current trust boundary is never mistaken for isolation.

## Shipped now: `host.shell`

`host.shell` authorizes native shell commands on a host Client Profile. It is a high-risk,
same-user capability with these invariants:

- the machine owner must include it explicitly in the Client Local Policy;
- the Session Scope must name it explicitly and receive human approval; it is never included in
  Read only or any other structured-access preset;
- it cannot be autoapproved or delegated;
- the Session Request identifies the machine, objective, duration, and capability without
  approving an advance list of commands;
- an active Session permits repeated, independent Host Shell Operations until expiry, cancellation,
  completion, or revocation;
- every Operation starts in the Home directory of the operating-system user running the Client by
  default; an explicit per-command working directory does not narrow the capability;
- commands run with everything that user can access, including files, credentials, network, local
  services, and user-owned processes;
- the Client supplies an allowlisted base environment rather than inheriting every variable from
  the Client process; explicit per-command environment values apply only to that Operation, are not
  shared with later Operations, and are never persisted;
- there is no filesystem root, sandbox, container boundary, command allowlist, process isolation,
  persistent terminal, PTY, or shell state shared between Operations;
- `cd`, exported variables, and other shell-local state end with each Operation, while filesystem,
  service, and other host changes may persist after the Session ends.

Structured `process.exec`, filesystem, and Docker Operations remain the narrower choices when the
task can be expressed with typed authority.

## Authorization and product surfaces

Enrollment presents Host Shell as an individual capability, never as part of a broad preset.
Manual Session creation offers Read only as the structured convenience preset and Host Shell as a
separate explicit selection. Approval surfaces repeat the same warning even when enrollment or
creation already displayed it.

The warning must state that commands run as the operating-system user running the Client, start in
that user's Home, can access that user's files, credentials, network, and services, have no sandbox
or isolation, and may persist changes after the Session ends.

Linux privilege escalation is independent. An installed systemd user service sets
`NoNewPrivileges=true` while sudo is disabled for that Profile. Enabling sudo locally verifies a
non-interactive `sudo -n -l` listing with at least one `NOPASSWD` rule, regenerates the service
without that restriction, and adds a second root-access warning to creation and approval. A Client
run directly in the foreground has no service-level `NoNewPrivileges` boundary: it retains the real
authority of the operating-system user and performs the same effective passwordless-sudo probe so
approval surfaces can warn about root access. Odyshell does not claim equivalent
privilege-escalation enforcement for macOS or Windows.

## Execution, expiry, and observability

Each Operation is separately identified, bounded by its timeout and output limit, and tied to the
active Session. Transport loss alone does not terminate an already authorized Operation. The Client
accepts no new Operations while disconnected, continues enforcing the local Operation timeout and
Session expiry, keeps only bounded output, and reconciles the result after reauthentication.
Operation output remains unconfirmed until the Server acknowledges the terminal result; a
disconnect or Client restart before that acknowledgement reports the output as truncated rather
than claiming that every chunk was persisted.
The Server blocks future work immediately after cancellation or revocation. A connected Client
receives terminal revocation and terminates the active process group. A physically disconnected
Client cannot receive that signal: it accepts no new work, continues enforcing the local Operation
timeout and Session expiry, and receives any still-pending Operation cancellation or drops revoked
Session authority on its next contact with the Server.
During that partition, the local timeout and expiry are the bounds on already authorized execution.
Session expiry and graceful Client shutdown also terminate the active process group. Those controls
revoke future authority; they cannot undo changes a completed command already made.

There is no separate Operation supervisor. On POSIX, commands run in detached process groups so
normal cancellation can terminate their descendants. If the Client crashes abruptly before it can
perform that cancellation, a command may continue until it exits by itself or the operating system
or machine owner stops it. After restart, Odyshell reports the result as unknown rather than
assuming the command stopped or completed successfully. This is an accepted limitation of the
current Host Shell implementation. Windows uses native `taskkill` tree termination, which cannot
reliably rediscover descendants after their process-group leader has already exited. If any graceful
termination path cannot prove that local authority ended, the Client persists a Profile quarantine,
stops accepting Server work, and refuses to reconnect after a service restart. Owner recovery is to
investigate remaining processes and remove and re-enroll that Profile.

Timeline handling follows the Session's selected detail level. Privacy-minimal data records
structure and status without command text or output. Operational detail may expose automatically
redacted commands and output while temporary Operation data remains available. Diagnostic detail
may expose raw temporary values, can contain secrets, and requires its existing explicit warning.
Environment values and standard input are never persisted. The process receives only the Client's
allowlisted base environment plus explicit values for that Operation. On POSIX, the login shell can
still load the user's startup files, and the command retains same-user access to those files.
Event Sinks never export command text, stdout, stderr, environment values or standard input at any
detail level.

## Removed host-root model

A host Client Profile is anchored to the Client process user and that user's Home, not a
configurable workspace root. Exact structured restrictions can still narrow individual filesystem
or `process.exec` authority. A Docker Profile has a Docker-specific mount source; that setting does
not constrain Host Shell because Host Shell is unavailable on Docker Profiles.

## Planned: `sandbox.shell`

`sandbox.shell` is not shipped. It will represent an isolated shell with a deliberately narrower
filesystem and process boundary and is intended to become the default choice for ordinary shell
work only after its isolation properties are implemented and tested.

Sandbox Shell and Host Shell must remain separate capabilities, Local Policy choices, warnings,
and Session Scopes. A workflow that outgrows Sandbox Shell must request a new linked Session for
`host.shell`; it must never widen the existing Session in place or silently fall back to the host.

## Security acceptance

Tests must prove that Host Shell is absent from every structured preset, denied outside both the
Session Scope and Local Policy, rejected by autoapproval and delegation, unavailable to Docker
Profiles, terminated when the Client observes authority loss, and always accompanied by the
same-user warning. Tests must also prove that the sudo warning is additive and reflects effective
foreground `sudo -n`; Server-side revocation immediately blocks future dispatch, a connected Client
receives terminal revocation, and a disconnected Client rejects new Operations, remains bounded by
local timeout and expiry, then drops authority on its next contact; environment and standard input
never persist; Event Sinks omit commands and output; and public documentation does not claim the
planned Sandbox Shell is available. Crash recovery must report detached POSIX execution
conservatively instead of claiming that an abrupt Client exit killed it.
