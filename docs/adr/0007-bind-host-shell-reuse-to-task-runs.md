---
status: superseded by ADR-0008
---

# Bind Host Shell reuse to Task Runs

Host Shell Sessions may be reused only within the Task Run that requested them. Agent-requested
Host Shell authority requires a stable Task Run identifier at the canonical Server boundary, and
the Server includes it in the reuse boundary alongside Agent and MCP installation identity. MCP
and SDK callers provide it, while the single-task CLI command generates one automatically. Manual
dashboard Sessions need no synthetic identifier and are never reused implicitly by programmatic
clients. MCP must present the identifier again when claiming, executing, completing, or renewing
attributed Host Shell authority. An unattributed manual Host Shell Session cannot be renewed
programmatically. This deliberately gives up convenient cross-task reuse so an interrupted task
cannot leave same-user machine authority available to unrelated work.
