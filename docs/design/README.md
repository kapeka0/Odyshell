# Accepted designs

These documents describe decisions that have completed product review but are not necessarily
implemented. Current behavior remains documented in the root and package READMEs and in the public
Fumadocs site.

- [Agent and Session model](./agent-session-model.md) defines the target product, security, and
  interaction model.
- [Agent and Session implementation plan](./agent-session-implementation-plan.md) organizes the
  migration into testable verticals.
- [Host Shell](./host-shell.md) specifies the accepted same-user trust boundary and keeps the
  future Sandbox Shell separate from shipped behavior.

Relevant architecture decisions:

- [Separate Agent identity from Session authority](../adr/0003-separate-agent-identity-from-session-authority.md)
- [Rotate Agent Credentials with bounded overlap](../adr/0004-rotate-agent-credentials-with-bounded-overlap.md)
- [Keep Client policy locally authoritative](../adr/0005-keep-client-policy-locally-authoritative.md)
- [Make native Host Shell explicit](../adr/0006-make-native-host-shell-explicit.md)
- [Bind Host Shell reuse to Task Runs](../adr/0007-bind-host-shell-reuse-to-task-runs.md)
