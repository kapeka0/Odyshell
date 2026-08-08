# Privacy and audit data

Odyshell records enough information to attribute and supervise agent work without retaining shell
output as a permanent session recording.

## Durable control data

The Server persists Organization, Human, Agent, Machine, Local Policy, Autonomy Policy, Task, and
Command state in PostgreSQL. Command records include the exact command text, optional working
directory, effective timeout, lifecycle timestamps, exit status, truncation state, and stdout and
stderr byte counts. This is deliberate: an owner must be able to determine what an Agent asked a
Machine to execute.

Task audit events record the acting Agent, Task and Command identifiers, lifecycle decision,
Machine and Client Profile identifiers, whether autonomy applied, Human approver identity and
role when applicable, and the Command metadata above. They do not contain credentials or retained
stdout/stderr.

Plaintext enrollment tokens and Machine credentials are returned only where the protocol requires
them. Stored credentials are hashed; Machine private keys remain on the Client. OAuth access and
refresh tokens are not copied into Odyshell audit events.

## Transient output

stdout and stderr pass through the Server and are stored in bounded PostgreSQL chunks so an
asynchronous Agent can page results after reconnecting. Each chunk expires after one hour and the
Server purges expired chunks periodically. Output is never copied into Task audit metadata.

A Command cannot supply environment variables or standard input through the Task protocol. A
shell may still read the executing Linux user's files, environment, startup files, credentials,
services, and network access; those are part of the Machine's same-user authority boundary.

## Website and infrastructure

The self-hosted Web distribution does not load third-party analytics or hosted avatar services.
Deployment owners may add proxy, platform, database, backup, or observability logs. Those systems
have independent collection and retention policies and may capture URLs, headers, or other data
outside Odyshell's application audit model.

TLS is required whenever Web, Server, MCP, or database traffic crosses a trusted host boundary.
Self-hosting operators control PostgreSQL, backups, proxy logs, and deletion. Removing live data
does not remove copies already present in backups.

## Important limit

Odyshell attributes requested Commands and their observed outcomes. It cannot infer or enumerate
every file, process, service, database, or external system changed by arbitrary shell text, and it
does not provide rollback or filesystem isolation.
