# Accepted designs

These documents describe decisions that have completed product review but are not necessarily
implemented. Current behavior remains documented in the root and package READMEs and in the public
Fumadocs site.

- [Agent and Session model](./agent-session-model.md) defines the target product, security, and
  interaction model.
- [Agent and Session implementation plan](./agent-session-implementation-plan.md) organizes the
  migration into testable verticals.

Relevant architecture decisions:

- [Separate Agent identity from Session authority](../adr/0003-separate-agent-identity-from-session-authority.md)
- [Rotate Agent Credentials with bounded overlap](../adr/0004-rotate-agent-credentials-with-bounded-overlap.md)
- [Keep Client policy locally authoritative](../adr/0005-keep-client-policy-locally-authoritative.md)
