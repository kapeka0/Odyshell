<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell Client</h1>

<p align="center"><strong>The lightweight connection from a private machine to Odyshell.</strong></p>

The Client creates an outbound connection to the Odyshell Server, receives approved typed
operations, and delegates them to process, filesystem, or Docker subsystems on the machine.

The machine does not need an inbound port, public IP, SSH account, or access from the agent to its
private network.

## Connect a machine

Install the CLI on the private machine:

```bash
npm install --global @odyshell/cli
```

Create an enrollment token on the administrator machine:

```bash
ods token create
```

Then, on the private machine:

```bash
ods up \
  --server <server-url> \
  --profile default \
  --token <token> \
  --name raspberry \
  --allow 'process.exec,fs.stat,fs.list,fs.search,fs.read,fs.write'
```

`ods up` enrolls the machine and starts a restartable user service: systemd on Linux, a LaunchAgent
on macOS, or a per-user Task Scheduler task with a native no-console launcher on Windows. The command returns after
the background Client starts, and closing the terminal does not disconnect the machine. No
administrator privileges are required. The operating-system user and `--allow` list form the
local policy. Relative paths in structured host Operations start from that user's Home; exact
absolute paths in those Operations can be approved per Session. Host Shell instead grants broad
authority before its commands or paths are known. The Server and remote agents
cannot grant themselves capabilities that the Client has not explicitly allowed.

Running `ods up` without enrollment options restarts the selected Profile safely. If its Cloud
machine was revoked, run a newly generated enrollment command with the same Profile; Odyshell
replaces the local identity only after the Server authorizes it. An active identity cannot be
replaced. Use a distinct name when one host connects to another Workspace or Server:

```bash
ods --server https://personal.example up --profile personal <enrollment-options>
ods --server https://company.example up --profile company <enrollment-options>
```

Every Profile has an independent configuration, machine identity, state directory, and background
service. Omitting `--profile` selects `default` and imports the previous single Client
configuration on first use. Migration conflicts fail closed. `--config` remains available for an
explicit path and cannot be combined with `--profile`.

List Profiles with `ods profiles ls` and remove one with `ods profiles remove <name>`. Use
`ods reset --yes` to sign out and remove every local Profile on the host. Cloud machine records
remain in the dashboard.

Installed Linux services set `NoNewPrivileges=true` while sudo is disabled for the Profile. A
machine owner can explicitly allow passwordless sudo with
`ods profiles configure <name> --allow-sudo`, and restore that service restriction with
`--deny-sudo`. Enabling verifies `sudo -n`, regenerates the service, and warns that approved
process Sessions may then run as root. `ods client start` runs in the foreground without the
service-level `NoNewPrivileges` boundary; the Client probes effective `sudo -n` and reports root
capability so approvals can warn even when the Profile setting is disabled. Odyshell does not
claim equivalent privilege-escalation enforcement on macOS or Windows.

## Security baseline

- Client configuration is validated locally and fails closed.
- Structured filesystem Operations must satisfy any exact Session path restriction.
- Every requested capability must be allowed both remotely and locally.
- Commands have time and output limits and are stopped when the Client observes their Operation or
  Session closing.
- Session deadlines are derived from Server time and excessive clock skew fails closed.
- A durable local journal prevents silent duplicate execution after reconnects.
- The Server blocks future work immediately after cancellation or revocation. A connected Client
  receives terminal revocation and stops active work. A physically disconnected Client cannot
  receive that signal: it accepts no new Operations, keeps output bounded, enforces local timeout
  and Session expiry, then drops the revoked authority on its next contact. During the partition,
  those local deadlines bound already authorized execution.

`host.shell` runs native commands as the user running the Client and starts each Operation in that
user's Home by default. An Operation can select another working directory, but that does not narrow
the same-user authority. Host Shell can access that user's files, credentials, network, and
services, has no sandbox or isolation, and may persist changes after the Session ends. For real
deployments, use a dedicated user without root, sudo, or Docker access, then grant only the
resources it needs. `docker.logs` is an explicit high-trust capability because access to Docker is
sensitive. A Docker Profile uses its own Docker-specific mount source, and Host Shell is unavailable
on Docker Profiles.

Host Shell starts a native login shell with an allowlisted base environment instead of copying
every variable from the Client process. Explicit `env` values apply only to that Operation and are
never persisted or carried to a later command. On POSIX, the login shell can still load the user's
startup files, and commands can read them under the same-user authority.

Graceful Session closure cancels the active process group. There is no separate Operation
supervisor: if the Client crashes abruptly, a detached POSIX command may continue until it exits by
itself or is stopped externally. After restart, the Client reports that execution as unknown
rather than assuming it stopped. Windows tree cancellation is best effort if the command leader
has already exited. When the Client cannot prove termination, it writes a local quarantine marker
and that Profile will not reconnect after restart. Investigate surviving processes, then remove and
re-enroll the Profile to clear its local state.

Docker is only required when using Docker operations or the optional `--runner docker` profile.
Node.js 24 or newer is required.

## Protocol v3 upgrade

Protocol v3 does not migrate protocol v2 Client Profiles. Stop and remove each old Profile, remove
its stale machine record in the dashboard, then run a newly generated enrollment command with the
same Profile name:

```bash
ods down --profile default
ods profiles remove default
# Run the new ods up command generated by the dashboard.
```

Host enrollment no longer accepts or stores `workspaceRoot`; relative work starts in the
operating-system user's Home. Docker enrollment requires both `--runner docker` and
`--mount-source <absolute-path>`, which becomes the Profile's `mountSource`. Recreate and re-enroll
the Profile instead of copying or editing its old configuration.

`ods client doctor` reports the Client and protocol versions. `ods client update` accepts only a
compatible patch release, verifies its npm SHA-512 integrity before installation, restarts the
existing service, and restores the previous verified package if restart fails.

[Back to Odyshell](../../README.md)
