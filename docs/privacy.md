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
or stderr in the durable control-event trail. A Session Timeline is a separate, scoped record. Its
Workspace level is captured when the Session is requested: Privacy-minimal excludes commands,
paths and output; Operational adds available details with automatic secret redaction; Diagnostic
keeps complete available details and can contain secrets. Command and output detail remains
temporary. Environment values and standard input are never persisted. Changing the Workspace
setting affects only new Sessions.

## Data classes

### Machine and access state

The Server persists machine identities, public keys, capability policy, hashed credentials,
Session state, and revocation state. Private machine keys remain on the Client. Plaintext
enrollment, Agent, and Session Credentials are returned once and are not stored.
Expired enrollment records are purged with temporary operation data. Disabling an Agent revokes
its credentials and closes its active Sessions without deleting retained Timeline or Control
Event history.

### Temporary operation data

The Server temporarily stores the persistable Operation action fields and output events so an
asynchronous Agent can retrieve a result and retry safely. Environment values and standard input
are transport-only and are never written to the database or Timeline. Their values are excluded
from the deterministic idempotency fingerprint; only a boolean recording whether transient input
was present is retained so a retry cannot add or remove it. Idempotency keys should be opaque,
unique values; they are delivery identifiers, not credentials.

This data may contain sensitive content. It becomes eligible for deletion after one hour by
default, together with completed session state that is no longer referenced. The Server runs the
purge at startup and every 15 minutes, so deletion can occur up to approximately 15 minutes after
the configured threshold. It is operational delivery state, not an audit recording. The purge
deletes the action, output and idempotency fingerprint with the Operation row.

The Server atomically reserves every idempotency key in a separate payload-free registry when it
creates the Operation. The registry contains only Workspace, Operation, machine, principal and
capability identifiers plus a domain-separated hash of the key. That single reservation remains
after payload purge, preventing cross-machine races and late retries from executing the Operation
again without retaining command or output content. It follows the control-event retention window.
Once only the reservation remains, the result cannot be replayed and a retry fails closed with
`idempotency_conflict`. An authenticated Client completion is acknowledged even after all Server
retention has elapsed, without recreating or auditing unknown state, so its local journal can stop
retrying.

Configure the window with:

```dotenv
ODYSHELL_OPERATION_RETENTION_SECONDS=3600
```

The supported range is 60 seconds to 7 days. Short windows improve privacy; longer windows make
late asynchronous result retrieval more reliable.

### Content-minimal control events

Control events and Operation idempotency reservations contain identifiers, lifecycle actions or
capability kind, timestamps, result status where applicable, and minimal policy metadata. They are
isolated by Workspace, become eligible for deletion after 30 days by default, and use the same
periodic purge.

Configure the window with:

```dotenv
ODYSHELL_AUDIT_RETENTION_DAYS=30
```

The supported range is 1 to 3,650 days. Self-hosting administrators are responsible for choosing a
period that matches their privacy, incident-response, and legal requirements.

## Event delivery

Agents can consume per-operation output as live server-sent events. A workspace can also configure
a signed HTTPS Event Sink for customer-owned delivery:

- signed HTTPS webhooks for application pipelines;
- object storage for customer-controlled retention;
- SIEM or log-stream integrations for security teams.

Odyshell Cloud should not require customers to buy long-term centralized storage of task content.
Delivery uses bounded retries and a dead-letter state. Endpoint validation blocks loopback,
private-network, link-local, and metadata-service destinations; redirects are not followed.
Event Sink detail is selected independently from the Workspace Timeline level.
Event Sinks never export command text, stdout, stderr, environment values or standard input at any
detail level.

## Website analytics

The hosted Odyshell website uses Vercel Web Analytics for page-view counts and aggregate traffic
information. Vercel describes this service as cookie-free and based on anonymized data. Odyshell
does not emit custom analytics events containing credentials, operation payloads, Timeline data,
command arguments, file paths, stdout, or stderr.

## Important limits

- Operation content passes through the Server while the operation is active.
- Temporary payloads are stored in PostgreSQL until the configured purge window expires.
- TLS is required whenever the Server is reachable over a network.
- A Host Shell command can have side effects that Odyshell cannot infer. The control event can
  identify that Host Shell execution occurred, but it cannot claim to enumerate every file,
  process, service, or external system changed by the command.
- Infrastructure operators may have independent database, proxy, container, or platform logs.
  Those systems have their own retention policies.

## Self-hosting responsibility

In a self-hosted deployment, the operator controls PostgreSQL, backups, proxy logs, and any
external event pipeline. Reducing the live database retention does not remove content from backups
that the operator has already created.
