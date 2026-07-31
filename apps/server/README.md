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
npm install --global @odyshell/cli
```

```bash
ods agent create coding-agent --machines <machine-id> --allow 'process.exec,fs.read' --for 1h
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
- Optional `ODYSHELL_WEB_KEY` and `ODYSHELL_WEB_URL` to enable the cloud web bridge.

Railway supplies `PORT` automatically. PostgreSQL stores machine identities, scoped tokens,
temporary sessions, operations, and content-minimal control events. Operation payloads expire
after one hour and control events after 30 days by default. Configure these windows with
`ODYSHELL_OPERATION_RETENTION_SECONDS` and `ODYSHELL_AUDIT_RETENTION_DAYS`.

Database credentials belong only to the Server; agents and Clients never receive them.
Cloud credential issuance is rate-limited per member and workspace. Expired enrollment records
and unreferenced inactive Agent Access records are removed by the retention sweep.
Deleting an Agent revokes its credential and closes active sessions atomically. The hidden record
remains only while retained sessions or Control Events still reference it.

Browser-approved Sessions use persistent Agent identities and one-time Session Credentials. The
Server stores only credential hashes and enforces the Session's exact machine, capability, path,
and expiry on every Operation. Verified lifecycle transitions form a privacy-minimal Session
Timeline without recording credentials or operation output.

Independent Agents may propose versioned autoapproval policies. Policies stay inactive until an
administrator approves their exact machine, capability, restriction, duration, and validity
ceiling. Out-of-policy requests remain pending, and every autoapproved Session retains the policy
ID and version used.

An approved Delegation Policy can derive one level of Managed Agent identities. Managed Agents
receive no durable credential and cannot delegate. The Server intersects the live parent policy,
child policy, Session scope, and Client policy for every request. Disabling a child or revoking
its parent closes derived Sessions and preserves attribution in Activity and Session Timelines.

Organizations own execution Workspaces. Existing self-hosted administrator endpoints use the
`x-odyshell-workspace-id` header and default to the backwards-compatible `default` workspace when
it is absent. Enrollment tokens, machines, Agent Access, sessions, operations, and control events
remain inside the selected Workspace. Agent requests do not accept a workspace selector: their
workspace comes from the hashed token record.

Keep one Server replica for the MVP because active Client connections are held by the running
process. The frontend calls authenticated internal endpoints and never accesses PostgreSQL
directly. `ODYSHELL_WEB_KEY` must be shared only between the web app and Server; production
startup rejects weak keys and non-HTTPS web origins.

[Self-hosting guide](../../docs/self-hosting.md) ·
[Privacy and event data](../../docs/privacy.md) ·
[Back to Odyshell](../../README.md)
