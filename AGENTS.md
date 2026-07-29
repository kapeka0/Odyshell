# Repository workflow

- After implementing code, configuration, documentation, or test changes, verify them, create a
  focused conventional commit, and push it to the configured upstream branch.
- Never commit secrets, client identities, enrollment tokens, local state, or generated
  credentials.
- Do not include unrelated working-tree changes in an implementation commit.
- If verification, commit, or push is blocked, report the blocker explicitly instead of claiming
  the change was delivered.

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
