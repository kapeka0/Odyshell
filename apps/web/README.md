<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell Web</h1>

<p align="center"><strong>Optional human supervision for the agent-native Odyshell control plane.</strong></p>

The web app is where Organization members approve CLI and Agent enrollment, connect or remove
Machines, supervise Tasks that fall outside autonomy policy, manage persistent Agents and their
policies, and review privacy-minimal audit events. Organization administrators additionally manage
people and Organization settings.

Agents are the primary operators. They use Organization-bound OAuth tokens through the canonical
HTTP API or its remote MCP adapter to discover Machines and manage resumable Tasks and Commands;
people use this interface for governance and optional supervision.

Public product documentation lives in `content/docs` and is served at `/docs` with local search.
The same reviewed source is available to agents through `/llms.txt`, `/llms-full.txt`, and a
Markdown version of every documentation page.

## Run locally

Copy the local identity configuration:

```bash
cp apps/web/.env.example apps/web/.env.local
```

Set a strong `BETTER_AUTH_SECRET` and use the same `ODYSHELL_WEB_KEY` in the web app and Server. For the Compose
Server, copy `.env.example` to `.env`; Compose forwards its key and
`ODYSHELL_WEB_URL=http://localhost:3000`. Start the backend and web app from the monorepo root:

```bash
docker compose up -d --build
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

Odyshell Identity uses Better Auth and PostgreSQL for people, sessions, Organization membership,
OAuth clients, and signed Agent access tokens. The web app forwards only verified identity to the
Odyshell Server over a shared internal key. Machine credentials and execution policy remain owned
by the Server.

[Server](../server/README.md) · [Back to Odyshell](../../README.md)
