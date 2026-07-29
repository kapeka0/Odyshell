<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell Server</h1>

<p align="center"><strong>The meeting point between AI agents and private machines.</strong></p>

The Server exposes the Odyshell API and accepts outbound Client connections. It authenticates
agents, checks machine and capability scopes, relays temporary tasks, and records an audit trail.

It does not connect directly to private networks and does not require inbound access to Client
machines.

## Run locally

From the monorepo root:

```bash
docker compose up -d --build
```

The development Server is then available at:

```text
http://127.0.0.1:4100
```

The local defaults are intended only for development. Agent access should use expiring tokens
created with explicit machine and capability scopes:

```bash
ods agent create coding-agent --machines <machine-id> --allow process.exec,fs.read --for 1h
```

Sessions cannot outlive the agent token that created them. Revoking a token also closes its active
sessions.

The Server is published on `127.0.0.1` by default. To test from another device, bind it to a
specific reachable host interface:

```bash
ODYSHELL_BIND_ADDRESS=<host-ip> docker compose up -d --build
```

```powershell
$env:ODYSHELL_BIND_ADDRESS="<host-ip>"
docker compose up -d --build
```

Publishing the Server makes its port reachable through that interface. Keep development
credentials private and use a host firewall appropriate for your test environment.

[Back to Odyshell](../../README.md)
