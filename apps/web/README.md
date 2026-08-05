<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell Web</h1>

<p align="center"><strong>The human control plane for Odyshell Cloud.</strong></p>

The web app is where workspace members approve CLI and Agent enrollment, connect or remove
machines, approve temporary Sessions, manage persistent Agents and their policies, and review
privacy-minimal Control Events. Organization administrators additionally manage people and
organization settings.

Agents do not use this interface. They use Agent Credentials and claimed Session Credentials
through the API, SDK, CLI, or MCP server.

Public product documentation lives in `content/docs` and is served at `/docs` with local search.
The same reviewed source is available to agents through `/llms.txt`, `/llms-full.txt`, and a
Markdown version of every documentation page.

## Run locally

Create a Clerk application with Organizations enabled, then copy this file:

```bash
cp apps/web/.env.example apps/web/.env.local
```

Set the Clerk keys and use the same `ODYSHELL_WEB_KEY` in the web app and Server. For the Compose
Server, copy `.env.example` to `.env`; Compose forwards its key and
`ODYSHELL_WEB_URL=http://localhost:3000`. Start the backend and web app from the monorepo root:

```bash
docker compose up -d --build
pnpm dev:web
```

Open `http://localhost:3000`, create an organization, then connect the CLI:

```bash
npm install --global @odyshell/cli
```

```bash
ods login --server http://localhost:4100
```

The CLI opens `/activate?code=...` with its short-lived device code already filled in. Approval
creates a workspace-bound CLI token. The dashboard can then issue single-use machine enrollment
commands, approve persistent Agent identities, and review their temporary Session requests.

An Agent Credential identifies a persistent Agent but grants no machine authority. Each task uses
an immutable Session for explicit machines and capabilities and expires within 24 hours. Host Shell
authority is broad, explicit, always requires manual approval, and is reusable only by the same
Task Run. Control Events never include command text, arguments, paths, file contents, stdout, or
stderr.

## Trust boundary

Clerk authenticates people and organization membership. The web app forwards only the verified
identity to the Odyshell Server over a shared internal key. PostgreSQL, machine credentials,
agent tokens and execution policy remain owned by the Server.

[Server](../server/README.md) · [Back to Odyshell](../../README.md)
