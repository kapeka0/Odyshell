# Odyshell community model

This document records the current distribution and community direction.

## Product thesis

Odyshell is the controlled execution boundary for AI agents that need temporary shell access to
real private Machines. It coordinates identity, Human approval, Agent roles, Session expiry, Local
Policy, revocation, and attributable timelines without handing Agents SSH credentials or network
access.

## Distribution

Odyshell is free and self-hosted. The supported product is the Docker Compose stack in this
repository; there is no managed SaaS tier, checkout, subscription, or commercial entitlement
service.

The repository remains licensed under Apache 2.0. Individuals and organizations may use, modify,
redistribute, and operate Odyshell commercially while retaining the required notices.

One installation owns one sovereign Organization and its PostgreSQL data. Members, Machines, and
Agents have no commercial limits. Technical safeguards remain mandatory and configurable where
appropriate:

- Machine Local Policy ceilings;
- Session and Command duration and concurrency bounds;
- rate limits and bounded resource state;
- output and audit retention;
- least-privilege operating-system identities.

## Public project

`odyshell.com` is the public landing and documentation site. It does not host authentication,
Organizations, dashboards, Agents, Machines, Sessions, or customer data. Product dashboards run
inside each Docker installation.

Community value is created through a secure, useful open implementation, reviewed documentation,
reproducible releases, and a contribution path that keeps the Session authority model coherent.
Future funding or hosted services require a new explicit product decision and must not silently
reintroduce payment code or commercial limits into the community distribution.

## Product boundary

Odyshell is not a remote desktop, VPN, SSH server, sandbox, secrets manager, scheduler, or
multi-agent orchestrator. Commands run with the privileges of the operating-system user running
the Client. Security depends on keeping that user least-privileged and enforcing authority outside
the Agent.

Member invitations remain future work until their secure delivery and onboarding path is shipped.
