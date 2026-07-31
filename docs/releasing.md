# Releasing Odyshell

Odyshell uses one coordinated pre-1.0 version for the Server, Client, web app, CLI, SDK, and
protocol package.

- A minor release such as `0.9.0` may contain an explicitly documented incompatible change.
- A patch release such as `0.9.1` must remain compatible with its minor release.
- Server, Client, CLI, SDK, and protocol versions must share the same minor version.
- `@odyshell/cli`, `@odyshell/sdk`, and `@odyshell/protocol` are public npm packages.
- Server, Client, MCP, and web releases are distributed through the repository, containers, CLI,
  and managed deployment rather than separate npm packages.

## Release checklist

1. Confirm no credentials, enrollment tokens, Client identities, local state, or environment files
   are staged.
2. Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm test:docs`, and `pnpm test:e2e`.
3. Confirm the E2E report covers Workspace isolation, expiry, revocation, replay, Local Policy,
   migration failure, rollback safety, and secret leakage.
4. Pack every public package into a temporary directory and inspect the archive contents.
5. Publish protocol, SDK, then CLI with public access.
6. Tag the verified commit and create a GitHub Release with compatibility and migration notes.
7. Deploy the Server first. Confirm its migration and health before deploying the web app.
8. Validate registration, approval, execution, Timeline, expiry, cancellation, and credential
   revocation from a desktop and Raspberry Pi.
9. If the Server migration fails, stop the rollout. Restore the pre-cutover PostgreSQL snapshot
   only if no new Session was accepted; otherwise fix forward. A schema rollback must never
   reactivate revoked authority.

Release evidence belongs in the release notes and Linear ticket. Never paste plaintext
credentials, operation content, or private infrastructure details into either.
