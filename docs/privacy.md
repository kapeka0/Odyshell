# Privacy and audit data

Odyshell records enough information to attribute, supervise, and reconstruct Agent work.

## Timeline data

PostgreSQL stores Organization, Human, Agent, Machine, Local Policy, Session, Command, approval, and
revocation state. A Command timeline includes exact command text, optional working directory,
effective timeout, lifecycle timestamps, exit status, truncation state, and bounded stdout/stderr.
The default output retention is 30 days; deployment owners may configure 1–365 days with
`ODYSHELL_COMMAND_OUTPUT_RETENTION_DAYS`. Audit retention defaults to 30 days.

OAuth access and refresh tokens, authorization headers, cookies, plaintext enrollment tokens, and
Machine private keys are not copied into timeline events. Enrollment tokens are stored only as
hashes and Machine private keys remain on the Client.

A Command cannot provide environment variables or standard input through the protocol. Its shell
can still read the Client user's files, startup files, credentials, services, and network access.
Those are part of the Machine's same-user authority boundary.

## Infrastructure

The self-hosted Web distribution does not load third-party analytics or hosted avatar services.
Deployment owners may add proxy, platform, database, backup, or observability logs with independent
retention. TLS is required whenever Web, Server, MCP, or database traffic crosses a trusted host
boundary. Deleting live data does not erase existing backups.

Odyshell attributes requested Commands and observed outcomes. It cannot enumerate every side effect
of arbitrary shell text and does not provide rollback, filesystem isolation, or tamper-proof audit.
