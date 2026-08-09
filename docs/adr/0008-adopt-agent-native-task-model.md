---
status: superseded by ADR-0010
---

# Adopt an agent-native Session and Command model

Odyshell will replace Workspace, Session, typed Operation, Managed Agent, and command-capability
language with Organization, Session, and Command. Each Session grants one Agent temporary authority on
one Machine as one operating-system user, and each Command is asynchronous non-interactive shell.
This deliberately trades the breadth of typed filesystem, process, Docker, delegation, and
multi-machine interfaces for a smaller agent-native contract whose real security boundary is the
Client's Local Policy and operating-system user. No compatibility aliases or migrations will keep
the superseded interface alive.

This decision supersedes the product model in ADR-0006 and ADR-0007. ADR-0003's separation of
durable Agent identity from temporary authority and ADR-0005's locally authoritative Client policy
remain in force under the new terms.
