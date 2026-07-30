---
status: superseded by ADR-0004
---

# Rotate Agent Credentials without overlap

Odyshell allows at most one active Agent Credential per Agent. Renewing issues a new secret and
immediately revokes the previous credential and closes its active sessions, avoiding forgotten
parallel secrets and residual access. This keeps the MVP revocation model simple at the cost of
requiring agents to switch credentials and reconnect atomically; manual revocation and expiry
apply the same session-closing rule.
