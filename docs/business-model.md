# Odyshell business model

This is a working public thesis, not a pricing commitment.

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
- a machine-operation API, SDK, and MCP surface.

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
- based on structured operations rather than an interactive terminal;
- enforceable at the Client, outside the model;
- embeddable through API, SDK, CLI, and MCP.

Shell execution can remain an explicit high-risk capability, but Odyshell must not claim to infer
every side effect of an arbitrary shell command.

## Commercial model

The pricing anchor should be managed capacity, not human seats.

A managed subscription should include:

- a number of active machines;
- one or more isolated workspaces;
- a generous operation allowance;
- a defined control-event retention period;
- a support level.

Operations are useful as a fair-use and overage metric, but they should not be the main sales
language. A filesystem stat and a long package upgrade have very different value despite both
being one operation. Customers should primarily understand the bill as governed capacity over a
predictable number of machines.

### Packaging hypothesis

| Package | Intended customer | Commercial boundary |
| --- | --- | --- |
| Developer | Evaluation and personal prototypes | Few machines, short retention, community support |
| Team | Agent startups and small platform teams | More machines and workspaces, team roles, webhooks |
| Business | Production agent products | Approvals, longer retention, event integrations, priority support |
| Enterprise | Regulated or large deployments | SSO/SCIM, SIEM, private deployment, SLA, data residency |

Exact prices and allowances should be set only after design-partner usage is measured.

Core safety must not be paywalled. Temporary grants, capability scopes, revocation, machine
identity, workspace isolation, and basic content-minimal events belong in every edition.
Monetization comes from managed scale, collaboration, retention, integrations, deployment options,
reliability, and support.

## Open and managed distribution

The Client, protocol, SDK, MCP integration, and a functional self-hosted path are adoption
mechanisms. Odyshell Cloud should monetize the managed control plane and operational guarantees.

The long-term license for commercial embedding is a separate decision. It should be made before
offering white-label or OEM distribution, but it is not required to validate the MVP.

## Organization and workspace model

The business model requires two boundaries:

- **Organization:** the paying company, its people, plan, and billing relationship.
- **Workspace:** an execution boundary for machines, agent grants, policies, and control events.

One organization may use workspaces for production, development, teams, or individual customers.
Human roles belong to the organization or workspace. Agents do not receive human roles; they
receive temporary grants scoped to machines, capabilities, and duration.

The initial human roles are:

| Role | Responsibility |
| --- | --- |
| Owner | Ownership, billing, administrators, and organization deletion |
| Admin | Members, workspaces, machine policy, and integrations |
| Operator | Machine enrollment and temporary agent grants |
| Auditor | Read and export content-minimal control events |
| Billing admin | Plan and invoice management only |

## Go-to-market

The first motion should be design partnerships, not enterprise feature breadth.

1. Recruit five agent vendors with a real need to operate on customer-owned Linux machines.
2. Integrate one repeatable workflow for each, such as updating a dependency or changing a
   configuration file.
3. Measure installation time, successful task completion, repeat use, denied operations, and
   support burden.
4. Convert customers when Odyshell becomes part of a recurring production workflow.
5. Expand by connected customer workspaces and active machines.

The primary activation metric is:

> A new customer connects a private machine and completes the first scoped agent operation in
> less than ten minutes.

Retention should be measured through workspaces with successful weekly operations, not logins to
an administrator dashboard.

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
