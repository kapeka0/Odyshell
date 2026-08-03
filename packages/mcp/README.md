<p align="center">
  <img src="../../assets/odyshell-square-light.svg" alt="Odyshell logo" width="72">
</p>

<h1 align="center">Odyshell MCP</h1>

<p align="center"><strong>One Session workflow for local and remote agent connections.</strong></p>

This private workspace package defines the MCP tools shared by `ods mcp` and the remote OAuth MCP.
Transport and credentials stay in their adapters; this package only translates tool calls into a
trusted runtime interface.

The surface includes machine discovery and ping, Session request/status/completion, typed Operation
execution, and Session timelines. It contains no enrollment, member, billing, or administrator
tools.

When a Session needs human approval, the tool result tells the agent to show the approval link and
wait for the user's decision before checking the request status.

The same pending request and review link are available from the Odyshell Sessions dashboard.

Requests can group several exact operations into one least-privilege scope per machine. Stable
Operation IDs make retries safe, and completion is rejected while an Operation remains active.
Groups that would create capability-path cross products are rejected.

Filesystem paths may be relative to the enrolled machine workspace or exact absolute paths on a
host profile. An absolute path is presented and approved as an exact filesystem scope. Docker
profiles reject absolute host paths. Restricted Sessions do not expose free-form shell;
`process.exec` remains available for an exact executable and argument array.

[MCP documentation](https://odyshell.com/docs/mcp) · [Back to Odyshell](../../README.md)
