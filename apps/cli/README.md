<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell CLI</h1>

<p align="center"><strong>The agent-facing command line for Odyshell.</strong></p>

The `ods` CLI gives agents a programmatic interface to Odyshell and lets workspace members connect
machines. People, plans, machine inventory, and approvals are managed in the web app.

## Install

Requires Node.js 24 or newer:

| Package manager | Command |
| --- | --- |
| pnpm | `pnpm add --global @odyshell/cli` |
| npm | `npm install --global @odyshell/cli` |
| Yarn | `yarn global add @odyshell/cli` |
| Bun | `bun add --global @odyshell/cli` |

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
machine identities, local policies, state, and background services. Omitting it selects `default`.

Remove one local Profile, or reset every local identity and CLI login:

```bash
ods client remove --profile personal
ods reset --yes
```

These commands do not delete Cloud machine records; remove those separately in the dashboard.

`ods` uses Odyshell Cloud by default. Self-hosted installations select their Server with
`--server <url>` or `ODYSHELL_SERVER_URL`.

Commands support `--json` for stable, programmatic output:

```bash
ods --json exec raspberry -- uname -a
```

## Main commands

- `ods up`, `ods status`, and `ods down` manage the outbound Client.
- `ods ping` checks end-to-end access without running a command.
- `ods exec`, `ods fs`, and `ods docker` request a narrowly scoped Session and perform one typed
  operation.
- `ods session` inspects and operates an already approved Session.
- `ods client` configures or removes the Client running on a private machine.
- `ods audit` shows actions visible to the current agent.
- `ods mcp` lets a signed-in agent request temporary access over MCP stdio.

`ods up` uses the current directory as the base for relative paths. Host Sessions can request an
exact absolute path, which remains visible in the approval. The Cloud Workspace selected during
`ods login` is the organization boundary; it is not a filesystem directory.

Legacy Agent Access and direct Session creation commands return migration guidance and do not
authorize work.

Check or update the local Client without replacing its identity or configuration:

```bash
ods client doctor
ods client update --check
ods client update
```

Updates are downloaded from npm over HTTPS, verified against the registry SHA-512 integrity,
limited to compatible patch releases, and rolled back if the background Client cannot restart.

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

The signed-in flow exposes machine discovery and ping, Session request recovery/status/completion,
typed operation execution, and the verified Session timeline. Machine discovery lets the agent
choose operations for the actual platform and locally allowed capabilities.
The agent receives an approval URL; after a member approves it, MCP claims the Session Credential
If a response is interrupted, the MCP can recover its recent request instead of asking for another
approval.

A request is derived from one or more typed operations: exact paths for filesystem work, exact
executables and arguments for `process.exec`, or exact containers for `docker.logs`. The MCP process cannot enroll
or revoke machines, create broader authority, expose credentials, or use administrator controls.

`ods shell` is deprecated for restricted Sessions. Use `ods exec` with an explicit program and
argument list.

For monorepo development, build and install the local CLI with:

```bash
pnpm install:ods
```

[Apache-2.0 license](./LICENSE) · [Documentation](https://odyshell.com/docs)

[Back to Odyshell](../../README.md)
