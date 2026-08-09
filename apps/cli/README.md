<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell CLI</h1>

<p align="center"><strong>Install and operate an Odyshell Client on Linux.</strong></p>

`ods` is the Machine-side administration tool. Agents do not run it: they connect to the
Odyshell Server through remote OAuth MCP or the canonical HTTP Task/Command protocol.

## Install

Requires Linux and Node.js 24 or newer:

```bash
npm install --global @odyshell/cli
```

## Connect a Machine

Open **Machines**, select **Add Machine**, and run the generated command on the target Linux host:

```bash
ods --server https://api.example.com up \
  --token <single-use-token> \
  --name production-api
```

Pass the optional `--agent-id <agent-id>` when this Profile should immediately allow one Agent.

`ods up` creates an Ed25519 Machine identity, saves a conservative Local Policy, verifies the
Server, and installs a restartable systemd user service. The token expires after ten minutes,
works once, and is never persisted.

Without `--agent-id`, the Machine registers and connects with a default-deny Local Policy and
cannot accept Tasks. When supplied, the initial Local Policy permits only that Agent. It also
permits one Task and Command at a time, a one-hour Task, a ten-minute Command, and 1 MiB of output.
It permits remote human approval but does not configure sudo or a sandbox.

## Local lifecycle

```bash
ods status
ods profiles ls
ods profiles status default
ods client status --profile default
ods client doctor --profile default
ods client update --check --profile default
ods down --profile default
ods up --profile default
```

Use another Profile name when one host connects to another Server or customer Organization.
Profiles keep independent Machine keys, policies, state directories, and systemd services.
`--profile` and `--config` cannot be combined.

Remove one local identity or all of them:

```bash
ods profiles remove default
ods reset --yes
```

Machine records remain in the dashboard for audit. `--json` provides stable output for local
automation.

## Security boundary

Commands execute as the Linux user running the Client. Use a dedicated user with no root, sudo,
or Docker membership and grant only the files, credentials, network, and services the Agent needs.
The Client enforces Organization, Agent, duration, concurrency, timeout, and output limits locally.

`ods` deliberately has no login, Agent, Task, Command, shell, filesystem, Docker, Session, or MCP
runtime commands. Keeping remote authorization in the Server prevents a second policy path from
appearing on every Machine.

For monorepo development:

```bash
pnpm install:ods
```

[Apache-2.0 license](./LICENSE) · [Documentation](https://odyshell.com/docs)

[Back to Odyshell](../../README.md)
