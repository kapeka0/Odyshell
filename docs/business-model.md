# Odyshell business model

This document records the current packaging and commercial direction.

## Product thesis

Odyshell is the controlled execution layer for AI agents that need to act on real private
machines.

It is not a remote desktop, an SSH replacement, a VPN, or a disposable agent sandbox. The product
sits between an agent and a customer-owned host and provides temporary identity, policy
enforcement, structured operations, revocation, and content-minimal control events.

The initial wedge is narrower than general infrastructure access:

> Help an agent vendor operate safely on a customer's private machines without building and
> distributing SSH credentials, exposing ports, or requiring the customer to adopt a network
> mesh or a full privileged-access platform.

## Initial customers

The primary customer is a company building an agent product that performs maintenance, support,
deployment, configuration, or investigation on infrastructure owned by its customers.

The buyer is likely to be a founder, product engineering lead, platform lead, or security lead.
The end customer installs the Odyshell Client and retains the final local policy boundary.

A secondary customer is an internal Platform or Security team introducing agents into its own
operational workflows.

## Value on both sides

For the agent vendor, Odyshell removes the need to build:

- private-network connectivity;
- machine enrollment and identity;
- credential distribution and rotation;
- temporary grants and revocation;
- execution retries and idempotency;
- a canonical machine-operation API and remote MCP surface.

For the owner of the machine, Odyshell avoids:

- sharing SSH credentials with an agent vendor;
- exposing an inbound port;
- granting access to the private LAN;
- installing the vendor's complete agent runtime;
- giving an agent permanent or unbounded access.

The company works only if it reduces integration work for the vendor and perceived risk for the
machine owner at the same time.

## Product boundaries

The defensible position is not generic connectivity. Existing products already solve tunnels,
private networking, human privileged access, and disposable sandboxes well.

Odyshell should remain:

- agent-first and programmatic;
- neutral across agent vendors and machine providers;
- focused on real, existing hosts;
- based on bounded Sessions and asynchronous shell Commands rather than an interactive terminal;
- enforceable at the Client, outside the model;
- integrable through canonical HTTP and remote OAuth MCP;

Shell execution is an explicit high-risk boundary. Odyshell must disclose that Commands run as the
Client's operating-system user, are not sandboxed, and may have persistent side effects after the
Session ends.

## Commercial model

The Pro pricing anchor is Organization membership, with explicit Machine limits and unlimited Agents.

A managed subscription should include:

- a number of active machines;
- a number of active OAuth Agents;
- a generous Session and Command allowance;
- a defined control-event retention period;
- a support level.

Commands are useful as a fair-use and overage metric, but they should not be the main sales
language. Customers should primarily understand the bill as governed capacity over a predictable
number of Machines and Agents.

### Current packaging

| Package | Price | Limits |
| --- | --- | --- |
| Free | $0 | One member, two Machines, two Agents |
| Pro | $30 USD per member/month | Up to 20 members, 20 Machines, unlimited Agents |
| Enterprise | Future | Not currently sold |

Member invitations are deferred until transactional email delivery is configured.

Core safety must not be paywalled. Temporary Sessions, Local Policy, revocation, Machine identity,
Organization isolation, and useful audit events belong in every edition.
Monetization comes from managed scale, collaboration, retention, integrations, deployment options,
reliability, and support.

## Open and managed distribution

The Client, protocol, MCP integration, and a functional self-hosted path are adoption
mechanisms. Odyshell Cloud should monetize the managed control plane and operational guarantees.

The long-term license for commercial embedding is a separate decision. It should be made before
offering white-label or OEM distribution, but it is not required to validate the MVP.

## Organization model

Organization is the sole tenant boundary: it owns Humans, Agents, Machines, Local Policies, Sessions,
Commands, audit, plan, and billing relationship. Cloud may host many isolated Organizations;
self-hosted mode permits exactly one sovereign Organization. A second Workspace tenant would add
authorization and navigation complexity without serving the MVP.

Human roles belong to the Organization. Agents do not receive Human roles or broad credentials;
OAuth identifies each Agent. A Standard Agent requires Human supervision; an Operator bypasses that
decision and must be treated like an Agent with SSH. Machine Local Policy enforces the resource ceiling but never
assigns an Agent. Commands execute only inside that Session's one-Machine authority.

Odyshell Identity manages Organization membership and the current Human roles:

| Role | MVP responsibility |
| --- | --- |
| Organization Member | Govern Machines, optionally supervise Sessions, and review audit events |
| Organization Admin | Member capabilities plus people and organization governance |

More specialized roles are a later governance feature:

| Role | Responsibility |
| --- | --- |
| Owner | Ownership, billing, administrators, and organization deletion |
| Admin | Members, Machine policy, Agents, and integrations |
| Operator | Machine enrollment and optional Session supervision |
| Auditor | Read and export content-minimal control events |
| Billing admin | Plan and invoice management only |

## Go-to-market

The first motion should be design partnerships, not enterprise feature breadth.

1. Recruit five teams running Agent or MSP workflows on customer-owned Windows, Linux, or macOS Machines.
2. Integrate one repeatable workflow for each, such as updating a dependency or changing a
   configuration file.
3. Measure installation time, successful session completion, repeat use, denied operations, and
   support burden.
4. Convert customers when Odyshell becomes part of a recurring production workflow.
5. Expand by connected customer Organizations and active Machines.

The primary activation metric is:

> A new customer connects a private Machine and completes the first Agent Session in
> less than ten minutes.

Retention should be measured through Organizations with successful weekly Sessions, not logins to an
administrator dashboard.

## Main risks

- **Positioning:** becoming another remote-access product.
- **Platform risk:** model and IDE vendors absorbing basic remote-workspace workflows.
- **Trust:** a security failure would damage the company disproportionately.
- **Overbuilding:** implementing enterprise governance before recurring agent workflows exist.
- **Open-core capture:** enabling commercial embedding without a sustainable managed offering.
- **Reliability:** a control plane that occasionally loses operations is not usable infrastructure.

The immediate validation question is not whether every enterprise feature can be built. It is
whether agent vendors and their customers both prefer this boundary to exchanging SSH access or
building a bespoke connector.
