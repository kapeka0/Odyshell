---
status: accepted
---

# Rotate Agent Credentials with bounded overlap

Normal Agent Credential rotation will issue a replacement and retire the previous credential
after a maximum ten-minute overlap, allowing unattended integrations to switch without downtime.
Retirement and ordinary expiry prevent new Session Requests but preserve already-issued Sessions;
explicit security revocation instead invalidates the credential immediately and cancels every
Session issued through it. This supersedes ADR-0002 because reliable rotation and emergency
response require different semantics.
