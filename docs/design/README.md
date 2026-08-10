# Accepted designs

These documents describe accepted target architecture and are not necessarily implemented.
Shipped behavior remains documented in the root and package READMEs and in the public Fumadocs
site.

- [Session control plane](./session-control-plane.md) defines the product, domain, trust boundaries,
  protocol, roles, retention, and self-hosted distribution.

Relevant architecture decisions:

- [Adopt Session authority and Agent roles](../adr/0010-adopt-session-authority-and-agent-roles.md)
- [Separate Agent identity from temporary authority](../adr/0003-separate-agent-identity-from-session-authority.md)
- [Keep Client policy locally authoritative](../adr/0005-keep-client-policy-locally-authoritative.md)
