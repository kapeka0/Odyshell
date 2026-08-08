<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Frontend UI workflow

- Read `UI_RULES.md` before changing the frontend.
- Add every newly agreed product UI direction to `UI_RULES.md` as part of the
  same implementation.
- Treat `design.md` as the source of truth for the shared visual foundation.
- Keep design guidance outcome-oriented. Do not prescribe a component, library,
  block, or interaction pattern in `design.md` or `UI_RULES.md`.

# Frontend implementation

- Reuse the existing UI primitives before introducing new ones.
- Use Odyshell Identity (Better Auth with PostgreSQL) as the source of human
  sessions, OAuth clients, Agent tokens, organization membership, and roles.
- Keep identity and authorization behind the shared `lib/identity` and
  `lib/identity-permissions` seams. Never authorize a product mutation from
  client state alone.
- Reuse workspace and server data already loaded by a shared layout instead of
  repeating requests during route transitions.
