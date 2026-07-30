---
status: accepted
---

# Separate Agent identity from Session authority

Odyshell will replace the legacy Agent Access aggregate with a persistent Agent identity and an
immutable, temporary Session that carries per-machine authority. Agent Credentials will prove
identity and request Sessions but will never execute machine operations; claimed Session
Credentials will execute only within the approved Session. This makes identity reusable without
making access permanent, gives every task an explicit lifecycle and Timeline, and supports
human-approved, autonomous, and delegated agent workflows through the same authorization model.

## Consequences

- Sessions can span multiple machines, but each machine has an independent scope.
- Capabilities and typed restrictions are intersected with the Client's Local Policy.
- Managed Agents have no durable credential and delegation is limited to one level.
- Legacy Agent Access tokens and active Sessions are revoked during a fail-closed migration.
- Public product language uses Agents and Sessions instead of Agent Access.
