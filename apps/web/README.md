<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell Web</h1>

<p align="center"><strong>Human identity and workspace administration for Odyshell Cloud.</strong></p>

The web app is where administrators register, select an organization, approve CLI access and
connect machines. Agents do not use this interface: they use scoped tokens through the API, SDK
or MCP server.

## Run locally

Create a Clerk application with Organizations enabled, then copy this file:

```bash
cp apps/web/.env.example apps/web/.env.local
```

Set the Clerk keys and use the same `ODYSHELL_WEB_KEY` in the web app and Server. Start both
processes from the monorepo root:

```bash
pnpm dev:server
pnpm dev:web
```

Open `http://localhost:3000`, create an organization, then connect the CLI:

```bash
ods login --server http://localhost:4100
```

The CLI opens `/activate` with a short-lived device code. Approval creates a workspace-bound CLI
token; the dashboard can then issue single-use machine enrollment commands.

## Trust boundary

Clerk authenticates people and organization membership. The web app forwards only the verified
identity to the Odyshell Server over a shared internal key. PostgreSQL, machine credentials,
agent tokens and execution policy remain owned by the Server.

[Server](../server/README.md) · [Back to Odyshell](../../README.md)
