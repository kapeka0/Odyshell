<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell CLI</h1>

<p align="center"><strong>The agent-facing command line for Odyshell.</strong></p>

The `ods` CLI gives agents a programmatic interface to Odyshell and lets workspace members connect
machines. People, plans, machine inventory, and Agent Access are managed in the web app.

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
- `ods mcp` exposes the same scoped operations to MCP-compatible agents over stdio.

`ods up --workspace <path>` refers to the local directory exposed by the Client. It is separate
from the Cloud Workspace selected during `ods login`.

The legacy administrator commands remain available for self-hosted development, but Cloud
organization management does not live in the CLI.

## MCP

Log in with a scoped agent token, then configure your agent to launch Odyshell:

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

The MCP process receives only agent tools. It cannot enroll or revoke machines, create tokens, or
use the administrator key. Each operation runs in a disposable session and remains auditable.

From the monorepo root, build and install the CLI with:

```bash
pnpm install:ods
```

[Back to Odyshell](../../README.md)
