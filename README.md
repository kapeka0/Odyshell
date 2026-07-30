<p align="center">
  <img src="./assets/odyshell-square-light.svg" alt="Odyshell logo" width="96">
</p>

<h1 align="center">Odyshell</h1>

<p align="center"><strong>Controlled execution for AI agents on private machines.</strong></p>

AI agents can use APIs and cloud services easily. Working with a real machine is still awkward:
it usually means sharing SSH credentials, exposing inbound ports, configuring a VPN, or
installing a complete coding agent on the machine.

Odyshell provides a smaller abstraction. A private machine runs a lightweight client, and that
client establishes an outbound connection to the Odyshell server. An agent can then request a
temporary session, perform a task, receive the result, and disconnect.

The agent never needs SSH credentials or direct access to the private network.

## How it works

```mermaid
flowchart LR
    A["AI agent"] -->|"Request a task"| O["Odyshell"]
    M["Private machine"] -->|"Outbound client"| O
    O -->|"Use existing connection"| M
    M --> E["Typed host operation"]
    E -->|"Output"| M
    M -->|"Return result"| O
    O -->|"Result"| A
```

The machine decides which workspace and capabilities are available. Anything not explicitly
allowed is denied by the Client. Operations run as the operating-system user running the Client
and results return through its existing outbound connection.

Odyshell is not an SSH client, VPN, or full coding agent. It is the infrastructure layer between
agents and private machines.

## Security principles

Odyshell treats every remote task as untrusted:

- Security is enforced by the Client and operating system, not by prompts.
- Agent permissions and local machine policy must both allow an operation.
- Filesystem operations stay inside the configured workspace.
- Process execution, shell access, filesystem writes, and Docker access are separate capabilities.
- Every session and operation is identified and bounded.
- Durable control events contain lifecycle metadata, not command or output recordings.

Host execution is intentionally direct: it can do anything available to the user running the
Client. Use a dedicated operating-system user and grant that user only the files and services an
agent should control. Docker execution remains available as an optional isolated profile.

## What using it looks like

Agents can use the Odyshell API directly. The `ods` CLI is the quickest way to try the same
workflow:

```bash
npm install --global @odyshell/cli
```

```bash
ods machines
ods exec raspberry -- uname -a
ods shell raspberry "pwd && id"
ods fs search raspberry package.json
ods fs write raspberry notes/hello.txt --content "Hello from an agent"
ods fs read raspberry notes/hello.txt
ods docker logs raspberry api --tail 100
```

Commands can also return structured output:

```bash
ods --json exec raspberry -- uname -a
```

## Try it locally

You need Node.js 24+, pnpm, and Docker. On macOS and Windows, use Docker Desktop with Linux
containers enabled.

Install Odyshell and start the server:

```bash
pnpm install
pnpm install:ods
docker compose up -d --build
```

This starts the development Server and PostgreSQL. State persists in a Docker volume. The bundled
credentials are only for local development and must not be exposed to the internet.

Connect the CLI:

```bash
ods login --server http://127.0.0.1:4100 --agent-token dev-agent-key --admin-key dev-admin-key
```

Create a one-time enrollment token:

```bash
ods token create
```

On a Linux machine, connect a workspace and start the persistent outbound Client:

```bash
ods up \
  --server http://127.0.0.1:4100 \
  --token <token> \
  --name my-machine \
  --workspace /srv/my-app \
  --allow process.exec,fs.stat,fs.list,fs.search,fs.read,fs.write
```

`ods up` installs a restartable user service. In another terminal:

```bash
ods exec my-machine -- uname -a
```

Check that the complete path to a machine is working:

```bash
ods ping my-machine
```

## Self-hosting

Odyshell can run with the Server and PostgreSQL on infrastructure you control. The Clients
still use outbound-only connections and do not expose ports.

See the [minimal self-hosting guide](./docs/self-hosting.md) for the current setup and production
security checklist.

## Use Odyshell Cloud

Cloud users create an account and organization in the web app. The organization owns the
Odyshell workspace; organization membership is intentionally not managed by the CLI.

Connect `ods` without copying a permanent administrator key:

```bash
ods login
```

The CLI prints and opens a short-lived Odyshell activation link with the device code already
included. After you approve it, `ods` receives an expiring workspace credential. The browser
session and Clerk credentials never leave the web app. Self-hosted installations can still select
their Server with `--server`.

From the dashboard, generate the one-time `ods up` command for a machine. The enrollment token
expires after ten minutes and can only be used once. You explicitly select the local operations
that machine will accept.

## Give an agent access

In the dashboard, create **Agent Access** with:

- a recognizable agent name;
- one or more existing machines;
- only the capabilities the task needs;
- an expiry from one hour up to one year.

The credential is shown once and can be revoked immediately. Give it to the agent, which can use
it through the API, SDK, CLI, or MCP:

```bash
ODYSHELL_AGENT_TOKEN=<agent-access> ods exec my-machine -- uname -a
```

From the Agent Access actions menu, revoke the credential without removing the record or delete
the access entirely. Deletion invalidates its credential and closes active sessions immediately;
privacy-minimal Control Events remain available until the configured retention period expires.

MCP-compatible agents can launch the same interface locally with `ods mcp`:

```json
{
  "mcpServers": {
    "odyshell": {
      "command": "ods",
      "args": ["mcp"]
    }
  }
}
```

The Server restricts Agent Access to its assigned machines, capabilities, and expiry. The Client applies its
own local policy as a second boundary. When the token expires, its sessions are closed too, so an
agent cannot keep access through an older session. The web app shows privacy-minimal Control
Events and never includes commands, arguments, paths, file contents, stdout, or stderr.

## MVP status

Odyshell currently supports typed process, shell, filesystem, and Docker log operations. Direct
host execution is the default. Docker sandboxes remain an optional execution profile.

The Server keeps machine identities, temporary access, operations, and audit history in PostgreSQL
through Kysely. Operation payloads are retained for one hour by default; content-minimal control
events are retained for 30 days. Odyshell does not provide session recording by default.

Organizations provide the ownership boundary and workspaces isolate machines, Agent Access, sessions,
operations, and control events. Human and organization identity now live in the Clerk-backed web
app. Device authorization binds the CLI to one workspace, while Agent Access remains separate,
scoped, revocable and expiring. Organization members can operate workspace resources; organization
administrators additionally manage people and organization settings. Billing is not enabled yet. It is an early development MVP; the
default local credentials are only for development.

## Product documents

- [Public documentation](https://odyshell.com/docs)
- [MVP scope and current behavior](./docs/mvp.md)
- [Privacy and event data](./docs/privacy.md)
- [Business model](./docs/business-model.md)
- [Self-hosting](./docs/self-hosting.md)
