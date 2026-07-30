<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell Web</h1>

<p align="center"><strong>The human control plane for Odyshell Cloud.</strong></p>

The web app is where workspace members approve CLI access, connect or remove machines, create,
revoke, or delete temporary Agent Access, and review privacy-minimal Control Events.
Organization administrators additionally manage people and organization settings.

Agents do not use this interface. They use Agent Access through the API, SDK, CLI, or MCP server.

Public product documentation lives in `content/docs` and is served at `/docs` with local search.
The same reviewed source is available to agents through `/llms.txt`, `/llms-full.txt`, and a
Markdown version of every documentation page.

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

The CLI opens `/activate?code=...` with its short-lived device code already filled in. Approval
creates a workspace-bound CLI token. The dashboard can then issue single-use machine enrollment
commands and scoped Agent Access credentials.

Agent Access always targets explicit machines and capabilities, expires after at most one year,
and is shown once. Control Events never include command text, arguments, paths, file contents,
stdout, or stderr.

## Trust boundary

Clerk authenticates people and organization membership. The web app forwards only the verified
identity to the Odyshell Server over a shared internal key. PostgreSQL, machine credentials,
agent tokens and execution policy remain owned by the Server.

[Server](../server/README.md) · [Back to Odyshell](../../README.md)
