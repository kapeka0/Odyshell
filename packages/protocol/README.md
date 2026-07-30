<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell Protocol</h1>

<p align="center"><strong>The shared contract between the Server, Client, and CLI.</strong></p>

`@odyshell/protocol` contains the TypeScript types and validation rules used across Odyshell. It
defines capabilities, session requests, typed process, filesystem and Docker operations, and
messages exchanged between the Server and Client. It also defines the strict Human, Agent, and
task Session identity contracts used by the ongoing Agent Access migration.

The package keeps both sides aligned without containing transport, authentication, or execution
logic.

## Development

From the monorepo root:

```bash
pnpm --filter @odyshell/protocol build
pnpm test
```

Protocol changes should remain compatible with the current `PROTOCOL_VERSION` or increment the
version when the message contract becomes incompatible.

[Back to Odyshell](../../README.md)
