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

Create an enrollment token on the administrator machine:

```bash
ods token create
```

Then, on the private Linux machine:

```bash
ods up \
  --server <server-url> \
  --token <token> \
  --name raspberry \
  --workspace /srv/my-app \
  --allow process.exec,fs.stat,fs.list,fs.search,fs.read,fs.write
```

`ods up` enrolls the machine and starts a restartable systemd user service. The workspace,
operating-system user, and `--allow` list form the local policy. The Server and remote agents
cannot grant themselves capabilities that the Client has not explicitly allowed.

Running the generated `ods up` command again is safe: if this host is already enrolled with that
Server, Odyshell restarts the existing identity instead of overwriting it. Connecting the same
host to another Odyshell Server creates an isolated configuration and systemd service
automatically. `--config` remains available when an explicit path is useful.

## Security baseline

- Client configuration is validated locally and fails closed.
- Filesystem operations cannot leave the configured workspace.
- Every requested capability must be allowed both remotely and locally.
- Commands have time and output limits and can be cancelled.
- A durable local journal prevents silent duplicate execution after reconnects.

Host processes have the permissions of the user running the Client. For real deployments, use a
dedicated user without root, sudo, or Docker access, then grant only the workspace permissions it
needs. `docker.logs` is an explicit high-trust capability because access to Docker is sensitive.

Docker is only required when using Docker operations or the optional `--runner docker` profile.
Node.js 24 or newer is required.

[Back to Odyshell](../../README.md)
