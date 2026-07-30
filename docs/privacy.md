# Privacy and event data

Odyshell must be auditable without becoming a surveillance or session-recording product.

## Default principle

Odyshell records the minimum information required to answer:

- which principal requested access;
- which machine or session was targeted;
- which capability or operation kind was used;
- whether the request was allowed, denied, completed, or revoked;
- when the lifecycle event happened.

It does not place command text, arguments, environment values, file paths, file contents, stdout,
or stderr in the durable control-event trail.

## Data classes

### Machine and access state

The Server persists machine identities, public keys, capability policy, hashed tokens, session
state, and revocation state. Private machine keys remain on the Client. Plaintext enrollment and
Agent Access credentials are returned once and are not stored.
Expired enrollment records are purged with temporary operation data. Inactive Agent Access
records are removed only after no retained session or Control Event still references them.

### Temporary operation data

The Server temporarily stores the full structured operation and its output events so an
asynchronous agent can retrieve a result and retry safely.

This data may contain sensitive content. It becomes eligible for deletion after one hour by
default, together with completed session state that is no longer referenced. The Server runs the
purge at startup and every 15 minutes, so deletion can occur up to approximately 15 minutes after
the configured threshold. It is operational delivery state, not an audit recording.

Configure the window with:

```dotenv
ODYSHELL_OPERATION_RETENTION_SECONDS=3600
```

The supported range is 60 seconds to 7 days. Short windows improve privacy; longer windows make
late asynchronous result retrieval more reliable.

### Content-minimal control events

Control events contain identifiers, lifecycle actions, timestamps, result status, and minimal
policy metadata. They are isolated by Workspace, become eligible for deletion after 30 days by
default, and use the same periodic purge.

Configure the window with:

```dotenv
ODYSHELL_AUDIT_RETENTION_DAYS=30
```

The supported range is 1 to 3,650 days. Self-hosting administrators are responsible for choosing a
period that matches their privacy, incident-response, and legal requirements.

## Event delivery

Agents can consume per-operation output as live server-sent events today. A workspace-level sink
for content-minimal control events is part of the next MVP milestone.

The intended model is customer-owned delivery:

- signed HTTPS webhooks for application pipelines;
- object storage for customer-controlled retention;
- SIEM or log-stream integrations for security teams.

Odyshell Cloud should not require customers to buy long-term centralized storage of task content.
Managed delivery, retries, integrations, and retention controls may be commercial features, while
the ability to export one's own control events remains a product requirement.

## Important limits

- Operation content passes through the Server while the operation is active.
- Temporary payloads are stored in PostgreSQL until the configured purge window expires.
- TLS is required whenever the Server is reachable over a network.
- An arbitrary shell command can have side effects that Odyshell cannot infer. The control event
  can identify that shell execution occurred, but it cannot claim to enumerate every file or
  process changed by the shell.
- Infrastructure operators may have independent database, proxy, container, or platform logs.
  Those systems have their own retention policies.

## Self-hosting responsibility

In a self-hosted deployment, the operator controls PostgreSQL, backups, proxy logs, and any
external event pipeline. Reducing the live database retention does not remove content from backups
that the operator has already created.
