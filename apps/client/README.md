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
  --workspace /srv/my-app \
  --allow 'process.exec,fs.stat,fs.list,fs.search,fs.read,fs.write'
```

`ods up` enrolls the machine and starts a restartable user service: systemd on Linux, a LaunchAgent
on macOS, or a limited Task Scheduler task on Windows. The workspace,
operating-system user, and `--allow` list form the local policy. The Server and remote agents
cannot grant themselves capabilities that the Client has not explicitly allowed.

Running the generated `ods up` command again is safe: if the selected Profile is already running,
Odyshell keeps its existing identity and local policy. Use a distinct name when one host connects
to another Workspace or Server:

```bash
ods --server https://personal.example up --profile personal <enrollment-options>
ods --server https://company.example up --profile company <enrollment-options>
```

Every Profile has an isolated configuration, machine identity, state directory, and background
service. Omitting `--profile` selects `default` and imports the previous single Client
configuration on first use. Migration conflicts fail closed. `--config` remains available for an
explicit path and cannot be combined with `--profile`.

## Security baseline

- Client configuration is validated locally and fails closed.
- Filesystem operations cannot leave the configured workspace.
- Every requested capability must be allowed both remotely and locally.
- Commands have time and output limits and are stopped when their operation or Session is closed.
- Session deadlines are derived from Server time and excessive clock skew fails closed.
- A durable local journal prevents silent duplicate execution after reconnects.

Host processes have the permissions of the user running the Client. For real deployments, use a
dedicated user without root, sudo, or Docker access, then grant only the workspace permissions it
needs. `docker.logs` is an explicit high-trust capability because access to Docker is sensitive.

Docker is only required when using Docker operations or the optional `--runner docker` profile.
Node.js 24 or newer is required.

`ods client doctor` reports the Client and protocol versions. `ods client update` accepts only a
compatible patch release, verifies its npm SHA-512 integrity before installation, restarts the
existing service, and restores the previous verified package if restart fails.

[Back to Odyshell](../../README.md)
