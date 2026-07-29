# Odyshell data

Convex stores durable Odyshell control-plane state: machine identities, scoped agent tokens,
temporary sessions, operations, output events, and audit history.

The Railway Server is the only caller of these functions today. Every call requires
`ODYSHELL_SERVICE_KEY`, which must match `ODYSHELL_CONVEX_SERVICE_KEY` on Railway. Clients and
agents never receive this secret.

From the repository root:

```bash
pnpm convex:dev
pnpm convex:deploy
```

The future web app can add Clerk-authenticated functions separately. Human login is intentionally
not part of the current agent and Client protocols.
