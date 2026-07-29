# Odyshell

Odyshell is an agent-first remote execution control plane. An agent requests a short-lived
session on a private machine, submits structured operations, and receives results without SSH,
a VPN, inbound ports, or direct access to the machine's network.

This repository contains a runnable MVP:

- TypeScript control plane with PostgreSQL persistence
- Outbound WebSocket connector with Ed25519 authentication
- One-time machine enrollment
- Locally enforced execution profiles and session TTLs
- Ephemeral Docker session sandboxes
- Structured process, shell, and filesystem operations
- Output streaming, cancellation, audit records, and idempotency keys
- Connector-local SQLite operation journal
- Agent/admin CLI

## Quick test

Prerequisites:

- Node.js 24 or newer
- pnpm
- Docker with a Linux engine

Run:

```powershell
pnpm install
pnpm install:ods
pnpm test
pnpm test:e2e
```

The end-to-end test builds and starts PostgreSQL and the control plane with Docker Compose,
enrolls a temporary connector, opens an isolated session, exercises command and filesystem
operations, verifies that network access and path traversal are blocked, and removes the
session container.

The control-plane containers remain running so you can inspect and use them:

```powershell
docker compose ps
docker compose logs -f control-plane
```

Stop them with:

```powershell
docker compose down
```

## Manual test

Start the control plane:

```powershell
docker compose up -d --build
```

Configure the CLI:

```powershell
ods login --server http://127.0.0.1:4100 --agent-key dev-agent-key --admin-key dev-admin-key
ods status
```

Create a one-time enrollment token:

```powershell
ods token create
```

Enroll the connector. Replace `<token>` with the returned token and choose the directory that
agents may access:

```powershell
ods connector enroll --token <token> --name my-machine --workspace C:\path\to\workspace
```

Start the outbound connector:

```powershell
ods connector start
```

In another terminal, list machines:

```powershell
ods machines
```

Run a command using either the machine name or ID. Odyshell creates and removes a disposable
session automatically:

```powershell
ods exec my-machine printf "hello from Odyshell\n"
ods shell my-machine "pwd && id"
ods fs write my-machine notes/hello.txt --content "written by an agent"
ods fs read my-machine notes/hello.txt
```

For a persistent session:

```powershell
ods session create my-machine --ttl 600
ods session exec <session-id> printf "hello\n"
ods session inspect <session-id>
ods session close <session-id>
```

Every data-producing command supports JSON for autonomous clients:

```powershell
ods machines --json
ods --json exec my-machine -- uname -a
```

## Tailnet-only deployment

To make the local control plane available to your Tailscale devices with HTTPS and WSS:

```powershell
tailscale serve --bg --yes http://127.0.0.1:4100
tailscale serve status
```

Use the generated HTTPS URL with `ods login` and with connectors on other devices. This is
Tailscale Serve, not Funnel, so the service remains private to the tailnet. See
`deploy/tailscale/README.md` for the complete workflow.

## API

The agent API uses `x-odyshell-agent-key`. Important endpoints:

```text
GET    /v1/machines
GET    /v1/sessions
POST   /v1/sessions
GET    /v1/sessions/:sessionId
DELETE /v1/sessions/:sessionId
POST   /v1/sessions/:sessionId/operations
GET    /v1/operations/:operationId
POST   /v1/operations/:operationId/cancel
GET    /v1/operations/:operationId/events
```

Operation event streams use Server-Sent Events. Connector traffic uses the versioned protocol
in `packages/protocol`.

## Security boundary

The default `workspace` profile:

- Runs commands in an ephemeral Linux container
- Mounts only the configured workspace
- Uses no network
- Does not mount the Docker socket
- Uses a read-only root filesystem and writable `/tmp`
- Drops all Linux capabilities
- Enables `no-new-privileges`
- Applies CPU, memory, PID, TTL, and output limits

Filesystem operations are constrained to relative paths below the configured workspace. Writes
are atomic and writing through symlinks is denied.

This MVP is for development, not an internet-facing production deployment. The Compose defaults
use known development API keys and unencrypted local HTTP. Before deployment, provide unique
keys, terminate TLS in front of the control plane, require `wss://` connectors, use rootless
Docker on the target, and review the local connector policy.

## Repository layout

```text
apps/control-plane   HTTP API, persistence, connector gateway
apps/connector       Outbound connector and Docker sandbox runner
apps/cli             Admin and agent command-line client
packages/protocol    Shared schemas, capabilities, and wire messages
deploy/systemd       Linux connector service template
deploy/tailscale      Tailnet-only HTTPS/WSS deployment guide
scripts/e2e.mjs      Full live integration test
tests                Protocol and policy tests
```
