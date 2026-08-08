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

1. Prepare one commit on `main` with every coordinated package version and
   `docs/releases/<version>.md`. Confirm no credentials, enrollment tokens, Client identities,
   local state, or environment files are staged.
2. Run `pnpm release:check`, push the commit, and wait for the cross-platform CI workflow.
3. Deploy the Server first. Confirm its migration and health before deploying the web app.
4. From the GitHub Actions page, run the `Release` workflow from `main` with the version number
   and approve its protected `Production` environment.
5. The workflow audits production dependencies, repeats type checking, tests, lint, build,
   documentation smoke tests and E2E; packs protocol, SDK and CLI; creates the immutable tag;
   publishes the packages through npm Trusted Publishing; creates the GitHub Release; and audits
   all public version surfaces.
6. Validate registration, approval, execution, Timeline, expiry, cancellation, and credential
   revocation from a desktop and Raspberry Pi.
7. If the Server migration fails, stop the rollout. Restore the pre-cutover PostgreSQL snapshot
   only if no new Session was accepted; otherwise fix forward. A schema rollback must never
   reactivate revoked authority.

Manual `npm publish`, release-tag pushes and GitHub Release creation are not supported. The
release workflow is idempotent: it skips an existing package only when its SHA-512 integrity
matches the package built from the release commit, and fails closed on any mismatch. A scheduled
read-only audit compares the coordinated repository version with npm, the git tag and GitHub's
latest release every day.

The documentation smoke step uses a synthetic Odyshell Identity secret and database URL scoped
only to that step so public search can be verified without production credentials.

## Trusted Publishing setup

Each public npm package trusts only `.github/workflows/release.yml` in `kapeka0/Odyshell`, bound
to the `Production` GitHub environment:

```bash
npm trust github @odyshell/protocol --file release.yml --repo kapeka0/Odyshell --env Production --yes
npm trust github @odyshell/sdk --file release.yml --repo kapeka0/Odyshell --env Production --yes
npm trust github @odyshell/cli --file release.yml --repo kapeka0/Odyshell --env Production --yes
```

After the trusted publishers are verified, configure npm publishing access to require two-factor
authentication and disallow tokens. The workflow receives only a short-lived OIDC identity and
the minimum GitHub permissions needed to create the tag and release.

Release evidence belongs in the release notes and Linear ticket. Never paste plaintext
credentials, operation content, or private infrastructure details into either.
