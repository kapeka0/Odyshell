<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell CLI</h1>

<p align="center"><strong>The agent-facing command line for Odyshell.</strong></p>

The `ods` CLI gives agents and administrators a simple interface to the Odyshell API. Agents use
it to work with private machines. Administrators use it to enroll machines and create scoped
access tokens.

## Basic usage

```bash
ods login --server <server-url> --agent-token <agent-token>
ods machines
ods exec raspberry -- uname -a
ods fs read raspberry notes/status.txt
ods audit
```

Commands support `--json` for stable, programmatic output:

```bash
ods --json exec raspberry -- uname -a
```

## Main commands

- `ods exec`, `ods shell`, and `ods fs` perform temporary tasks.
- `ods session` manages longer-lived temporary sessions.
- `ods agent create` creates scoped agent tokens.
- `ods client` configures the client running on a private machine.
- `ods audit` shows actions performed by the current agent.

From the monorepo root, build and install the CLI with:

```bash
pnpm install:ods
```

[Back to Odyshell](../../README.md)
