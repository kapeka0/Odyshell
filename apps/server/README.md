<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell Server</h1>

<p align="center"><strong>The agent-native control plane for private Linux Machines.</strong></p>

The Server exposes canonical Task and Command HTTP endpoints, the remote OAuth MCP adapter, and an
authenticated outbound Client gateway. It owns Agent authorization, idempotency, lifecycle and
audit, while each Linux Client independently enforces the Machine owner's Local Policy.

The Server never opens a connection into a private network. A Machine connects outbound, and a
Command runs as the operating-system user that runs the Client. Odyshell does not add a sandbox,
sudo, rollback, or an inbound SSH surface.

## Run the self-hosted stack

From the repository root:

```bash
cp .env.example .env
docker compose up -d --build
pnpm test:self-host
```

Fill every blank secret in `.env` first. The manifest starts PostgreSQL, Server, Better
Auth identity, dashboard, and public documentation. It uses production mode and fails closed when
`POSTGRES_PASSWORD`, `ODYSHELL_WEB_KEY`, or `BETTER_AUTH_SECRET` is absent.

Open `http://localhost:3000` and create the one Organization allowed by self-hosted mode. Agent
runtimes connect to `http://localhost:4100/mcp`; Linux Machines enroll through the dashboard and
initiate their own authenticated outbound connection.

## Production boundary

- Put the public web and Server origins behind TLS and set `BETTER_AUTH_URL`,
  `NEXT_PUBLIC_ODYSHELL_SERVER_URL`, and `ODYSHELL_MCP_URL` to their canonical HTTPS URLs before
  building the images.
- Keep PostgreSQL private, require TLS when it crosses a host boundary, and test encrypted backups
  and restores.
- Supply secrets through the deployment platform. Never commit `.env`, Machine private keys,
  OAuth secrets, or enrollment tokens.
- Keep one Server replica for this release because live Client connections are process-local.
- Run each Client as a dedicated least-privilege Linux user without root, sudo, or Docker group
  membership.
- Deploy the Web and Server from the same release. Both use the same PostgreSQL database and
  `ODYSHELL_WEB_KEY`.

The web app provides local email/password identity through Better Auth. Google sign-in and generic
OIDC are optional and require their server credentials plus matching build-time UI flags. Generic
OIDC uses discovery, PKCE, and strict issuer validation. No Clerk or hosted identity service is
required.

[Self-hosting guide](../../docs/self-hosting.md) ·
[Privacy and event data](../../docs/privacy.md) ·
[Back to Odyshell](../../README.md)
