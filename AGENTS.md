# Repository workflow

- After implementing code, configuration, documentation, or test changes, verify them, create a
  focused conventional commit, and push it to the configured upstream branch.
- Never commit secrets, client identities, enrollment tokens, local state, or generated
  credentials.
- Do not include unrelated working-tree changes in an implementation commit.
- If verification, commit, or push is blocked, report the blocker explicitly instead of claiming
  the change was delivered.

# Engineering principles

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility
  layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative
  abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each
  new capability on top of a product that already works. Never trade a working product for
  unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve
  reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding
  packages. Do not assume a library lacks a capability without checking its documentation and
  types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now
  and is meant to be replaced later.
- Use optimistic UI for every safe, reversible frontend mutation. Apply the intended state before
  waiting for the network, reconcile it with the server in the background, and roll it back with
  clear feedback on failure. Never present an irreversible or security-sensitive outcome as
  successful before the server confirms it.

# Security by design

- Treat every change as security-sensitive because Odyshell grants remote agents access to machine
  operations, including command execution and filesystem access.
- Design security into protocols and implementations from the start. Define trust boundaries,
  authenticate identities, enforce authorization outside the agent, apply least privilege and
  default-deny behavior, fail closed in production, and preserve useful audit trails without
  recording secrets.
- Every implementation change must include or update security tests proportional to the affected
  attack surface. Always test relevant denial and abuse cases, not only successful behavior.
- Changes involving authentication, tokens, sessions, operations, paths, processes, Docker,
  networking, or audit data are incomplete until their relevant security properties have been
  tested. Consider token expiry and revocation, scope bypass, replay, injection, path traversal,
  symlink escape, resource limits, identity verification, and secret leakage where applicable.
- Development shortcuts must be explicit, isolated from production, and tested to ensure they
  cannot become production defaults.

# Documentation

- After every implementation, review the root and package READMEs, repository Markdown files,
  and public online documentation for required updates.
- Keep documentation synchronized with shipped behavior. Do not present planned features as
  available.
- Treat `docs/design/` as accepted target architecture, not shipped behavior. Promote a design
  into public usage documentation only after its corresponding vertical is implemented and
  verified.
