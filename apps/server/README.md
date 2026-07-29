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

The development Server is available at `http://127.0.0.1:4100`. Compose starts PostgreSQL and
stores its data in a named volume, so local state survives Server restarts.

The bundled database password and Odyshell keys are development defaults. Agent access should use
expiring, scoped tokens:

```bash
ods agent create coding-agent --machines <machine-id> --allow process.exec,fs.read --for 1h
```

Sessions cannot outlive the token that created them. Revoking a token also closes its active
sessions.

To test from another device, bind the development Server to a specific reachable host interface:

```bash
ODYSHELL_BIND_ADDRESS=<host-ip> docker compose up -d --build
```

## Deploy

A production deployment needs:

- `DATABASE_URL` pointing to PostgreSQL with TLS enabled.
- `ODYSHELL_ADMIN_KEY` set to a strong, private value.
- `HOST=0.0.0.0`.

Railway supplies `PORT` automatically. PostgreSQL stores machine identities, scoped tokens,
temporary sessions, operations, and audit events. Database credentials belong only to the Server;
agents and Clients never receive them.

Keep one Server replica for the MVP because active Client connections are held by the running
process. The future frontend will call the Odyshell API and will not access PostgreSQL directly.

[Self-hosting guide](../../docs/self-hosting.md) ·
[Back to Odyshell](../../README.md)
