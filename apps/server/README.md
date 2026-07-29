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

Docker Compose uses an in-memory store so local tests leave no machines, tokens, or audit data
behind. For persistent development, connect the repository to Convex and run:

```bash
pnpm convex:dev
pnpm dev:server
```

The local defaults are intended only for development. Agent access should use expiring tokens:

```bash
ods agent create coding-agent --machines <machine-id> --allow process.exec,fs.read --for 1h
```

Sessions cannot outlive the agent token that created them. Revoking a token also closes its active
sessions.

Administrators can list all machine identities with `ods machines --admin` and revoke an identity
with `ods machine revoke <name-or-id>`. Revocation disconnects the Client while retaining its
history for audit.

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

## Deploy for testing

The repository includes a Railway configuration for the Server. A production deployment needs:

- `CONVEX_URL` pointing to the production Convex deployment.
- `ODYSHELL_CONVEX_SERVICE_KEY` matching the secret stored in Convex.
- `ODYSHELL_ADMIN_KEY` set to a strong, private value.
- `HOST=0.0.0.0`.

Railway supplies `PORT` automatically. Convex stores machines, scoped tokens, temporary sessions,
operations, and audit events. The service key is only for the Railway Server; agents and Clients
never receive it.

Keep one Railway replica for now because active Client connections are held by the running Server
process. The future web app can use Clerk with Convex directly for human identity without changing
the agent-token or machine-identity protocols.

[Back to Odyshell](../../README.md)
