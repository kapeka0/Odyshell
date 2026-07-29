<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell Client</h1>

<p align="center"><strong>The lightweight connection from a private machine to Odyshell.</strong></p>

The Client runs on Linux, macOS, or Windows. It creates an outbound connection to the Odyshell
Server, receives approved tasks, and executes them inside temporary Linux containers.

The machine does not need an inbound port, public IP, SSH account, or access from the agent to its
private network.

## Connect a machine

Create an enrollment token on the administrator machine:

```bash
ods token create
```

Then, on the private machine:

```bash
ods client doctor
ods client enroll --token <token> --name raspberry --workspace ./workspace --allow process.exec,fs.stat,fs.list,fs.read
ods client start
```

The workspace and `--allow` list form the local policy. The Server and remote agents cannot grant
themselves capabilities that the Client has not explicitly allowed.

## Security baseline

- Client configuration is validated locally and fails closed.
- Containers have no network, host credentials, or access to the host Docker socket.
- The container root filesystem is read-only and runs without Linux capabilities.
- The workspace mount is read-only unless a write capability is granted.
- Sessions have CPU, memory, process, output, and time limits and are deleted when closed.

Process execution can read the selected workspace. Do not place credentials inside that directory.
This MVP uses hardened containers and does not claim the microVM isolation of Docker Sandboxes.

Docker and Node.js 24 or newer are required.

[Back to Odyshell](../../README.md)
