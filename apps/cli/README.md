<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell CLI</h1>

<p align="center"><strong>Install Machines and operate a self-hosted Odyshell control plane.</strong></p>

`ods` is both the cross-platform Machine administration tool and a Human OAuth client for the
Odyshell control plane. Agents normally connect through remote OAuth MCP or the canonical HTTP
Session/Command protocol.

## Install

Requires Windows, Linux, or macOS and Node.js 24 or newer:

```bash
npm install --global @odyshell/cli
```

## Connect a Machine

Open **Machines**, select **Add Machine**, and run the generated command on the target Windows, Linux, or macOS host:

```bash
ods --server https://api.example.com up \
  --token <single-use-token> \
  --name production-api
```

`ods up` creates an Ed25519 Machine identity, saves a conservative Local Policy, verifies the
Server, and installs a restartable background service for the host platform. The token expires after ten minutes,
works once, and is never persisted.

The CLI defaults to `http://localhost:4100`. Use `--server https://api.example.com` for a remote
self-hosted installation; there is no managed Server fallback.

## Human control

Sign in through the browser, then inspect and supervise the same resources as the dashboard:

```bash
ods login
ods machines list
ods agents list
ods agents role <agent-id> operator
ods sessions list
ods sessions approve <session-id>
ods sessions timeline <session-id>
ods commands run <session-id> --command "uname -a"
ods logout
```

The Local Policy permits one Session and Command at a time, a one-hour Session, a ten-minute Command,
and 1 MiB of output.
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
Profiles keep independent Machine keys, policies, state directories, and background services.
`--profile` and `--config` cannot be combined.

Remove one local identity or all of them:

```bash
ods profiles remove default
ods reset --yes
```

Machine records remain in the dashboard for audit. `--json` provides stable output for local
automation.

## Security boundary

Commands execute as the operating-system user running the Client. Use a dedicated account without
administrator, root, sudo, or Docker authority and grant only the files, credentials, network, and services the Agent needs.
The Client enforces Organization, Session identity, duration, concurrency, timeout, and output limits
locally. Agents receive temporary Machine authority only through authorized Sessions.

Human CLI commands use the same Server-side authorization and Session services as the web app.
The CLI does not create a parallel Machine policy path: Agents still receive Machine authority only
through an authorized, expiring Session.

For monorepo development:

```bash
pnpm install:ods
```

[Apache-2.0 license](./LICENSE) · [Documentation](https://odyshell.com/docs)

[Back to Odyshell](../../README.md)
