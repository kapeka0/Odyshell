<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell CLI</h1>

<p align="center"><strong>The agent-facing command line for Odyshell.</strong></p>

The `ods` CLI gives agents a programmatic interface to Odyshell and lets workspace members connect
machines. People, plans, machine inventory, and Agent Access are managed in the web app.

## Install

Requires Node.js 24 or newer:

```bash
npm install --global @odyshell/cli
```

## Basic usage

```bash
ods login
ods machines
ods ping raspberry
ods exec raspberry -- uname -a
ods fs search raspberry package.json
ods fs read raspberry notes/status.txt
ods audit
```

`ods login` prints an activation link with its short-lived device code already embedded. Open that
link, choose the workspace, and approve the CLI; there is no code to copy manually.

`ods login` authorizes the CLI but does not enroll the current machine. Use the **Add machine**
flow in the web app and run its generated `ods up` command on the target host. A host can maintain
isolated outbound Clients for multiple Workspaces or Servers with named Profiles:

```bash
ods --server https://personal.example up --profile personal <enrollment-options>
ods --server https://company.example up --profile company <enrollment-options>
```

Use the same `--profile` with `ods down` and `ods client status`. Profiles keep independent
machine identities, local policies, state, and Linux services. Omitting it selects `default`.

`ods` uses Odyshell Cloud by default. Self-hosted installations select their Server with
`--server <url>` or `ODYSHELL_SERVER_URL`.

Commands support `--json` for stable, programmatic output:

```bash
ods --json exec raspberry -- uname -a
```

## Main commands

- `ods up`, `ods status`, and `ods down` manage the outbound Client.
- `ods ping` checks end-to-end access without running a command.
- `ods exec`, `ods shell`, `ods fs`, and `ods docker` perform typed operations.
- `ods session` manages longer-lived temporary sessions.
- `ods client` configures the client running on a private machine.
- `ods audit` shows actions visible to the current agent.
- `ods mcp` lets a signed-in agent request temporary access over MCP stdio.

`ods up --workspace <path>` refers to the local directory exposed by the Client. It is separate
from the Cloud Workspace selected during `ods login`.

The legacy administrator commands remain available for self-hosted development, but Cloud
organization management does not live in the CLI.

## MCP

Run `ods login`, then configure your agent to launch Odyshell:

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

The default signed-in flow exposes machine discovery, Session request/status and exact file reads.
The agent receives an approval URL; after a member approves it, MCP claims the Session Credential
once and keeps it out of model-visible tool results.

A Session is bound to one machine, `fs.read`, one exact path and an expiry. The MCP process cannot
enroll or revoke machines, create broader authority, expose the credential, or use administrator
controls. Agent Access tokens retain the existing pre-scoped tools for compatibility.

For monorepo development, build and install the local CLI with:

```bash
pnpm install:ods
```

[Apache-2.0 license](./LICENSE) · [Documentation](https://odyshell.com/docs)

[Back to Odyshell](../../README.md)
