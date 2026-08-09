---
status: accepted
---

# Bind Agents to Machines only through Tasks

A Machine belongs to one Organization, never to an Agent. Agent-to-Machine
authority exists only through a temporary Task, with Autonomy Policy or optional human approval
deciding whether it opens. Local Policy remains the Machine owner's independent resource ceiling
for duration, concurrency, Commands, output, and supervision; embedding Agent allow-lists there
would couple two durable identities, hide Organization Machines from Agents, and make enrollment
order-dependent without independently authenticating an Agent at the Client boundary.
