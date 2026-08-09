---
status: accepted
---

# Adopt Session authority and Agent Roles

Odyshell uses a Session as temporary shell authority for exactly one Agent and one Machine, with
asynchronous non-interactive Commands and a durable attributable Timeline. Standard Agents require
a Human decision for every Session, while Operator Agents may obtain Sessions without a new Human
decision but remain bounded by the Machine's Local Policy. This restores the product's access and
traceability model while preserving the durable Agent identity and locally enforced Machine ceiling.

This decision supersedes ADR-0008 and removes Task and Autonomy Policy from the public and internal
domain without compatibility aliases.
