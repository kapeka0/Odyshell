# Rotate Agent Credentials without overlap

Odyshell allows at most one active Agent Credential per Agent. Renewing issues a new secret and
immediately revokes the previous credential, avoiding forgotten parallel secrets and keeping the
MVP revocation model simple at the cost of requiring agents to switch credentials atomically.
