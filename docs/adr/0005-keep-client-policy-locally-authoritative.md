---
status: accepted
---

# Keep Client policy locally authoritative

The Local Policy of a Client Profile remains a machine-owner-controlled security ceiling that
Cloud, web, API, CLI, and MCP integrations cannot expand remotely. Remote systems may observe the
reported policy, reject incompatible requests, reduce authority, or revoke Sessions, but widening
roots, capabilities, programs, or containers requires a local machine action. This preserves a
useful boundary even if the control plane or a human account is compromised.
