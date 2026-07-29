<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell SDK</h1>

<p align="center"><strong>Give TypeScript agents temporary, scoped access to private machines.</strong></p>

`@odyshell/sdk` is the programmatic interface to Odyshell. An agent uses its short-lived token to
find an allowed machine and request a typed operation. Odyshell opens a temporary session, sends
the operation through the machine's outbound connection, records it for audit, and closes the
session.

```ts
import { Odyshell } from "@odyshell/sdk";

const ods = new Odyshell({
  serverUrl: process.env.ODYSHELL_SERVER_URL!,
  agentToken: process.env.ODYSHELL_AGENT_TOKEN!,
});

const result = await ods.process.exec({
  machine: "rpi5",
  program: "git",
  args: ["status", "--short"],
});

console.log(result.stdout);
```

The SDK supports typed process, filesystem, and Docker log operations. Permissions are still
enforced by the Server, the agent token, and the Client on the target machine.

Use `process.exec` when possible. `process.shell` is available for commands that genuinely need a
shell and should receive a separate, explicit capability.

[Back to Odyshell](../../README.md)
