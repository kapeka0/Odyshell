# Releasing Odyshell

Before retiring a managed Railway installation, run
`powershell -File scripts/backup-railway.ps1`. The tool creates a CMS-encrypted PostgreSQL dump,
keeps its private key in the current Windows user's certificate store, verifies a decrypt hash,
and requires `pg_restore --list` to parse the decrypted temporary before reporting success.
Use `scripts/transfer-cms-backup.ps1` with the manifest's decrypted SHA-256 when a verified dump
must be restored on another host. The transfer tool validates its destination, applies mode `600`,
and always deletes the local decrypted temporary.
On the destination, `scripts/restore-postgres.sh` accepts only a regular mode-`600` custom dump,
restores it into the Compose PostgreSQL service with `--exit-on-error`, reports Organization and
Machine counts, and removes both host and container plaintext copies through an exit trap.

Odyshell uses one coordinated pre-1.0 version for the Server, Client, web app, CLI, MCP runtime,
and protocol package.

- A minor release such as `0.9.0` may contain an explicitly documented incompatible change.
- A patch release such as `0.9.1` must remain compatible with its minor release.
- Server, Client, CLI, MCP, and protocol versions must share the same minor version.
- `@odyshell/cli` and `@odyshell/protocol` are the only public npm packages.
- Server, Client, MCP, and web releases are distributed through the repository, containers, CLI,
  and managed deployment rather than separate npm packages.

## Release checklist

1. Prepare one commit on `main` with every coordinated package version and
   `docs/releases/<version>.md`. Confirm no credentials, enrollment tokens, Client identities,
   local state, or environment files are staged.
2. Run `pnpm release:check`, push the commit, and wait for the cross-platform CI workflow.
3. Deploy the Server first. Confirm its control and Session migrations and health before deploying
   the web app.
4. Web migrates identity automatically before accepting traffic. Operators that set
   `ODYSHELL_RUN_IDENTITY_MIGRATIONS=false` must run `pnpm migrate:identity` first; the command is
   idempotent and takes a PostgreSQL advisory lock.
5. From the GitHub Actions page, run the `Release` workflow from `main` with the version number
   and approve its protected `Production` environment.
6. The workflow audits production dependencies, repeats type checking, tests, lint, build,
   documentation smoke tests and E2E; packs protocol and CLI; creates the immutable tag;
   publishes the packages through npm Trusted Publishing; creates the GitHub Release; and audits
   all public version surfaces.
7. Validate enrollment, Session approval, Command execution, audit, expiry, cancellation, and OAuth
   revocation from a desktop and Raspberry Pi.
8. If any migration fails, stop the rollout and fix forward. A schema rollback must never
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
npm trust github @odyshell/cli --file release.yml --repo kapeka0/Odyshell --env Production --yes
```

After the trusted publishers are verified, configure npm publishing access to require two-factor
authentication and disallow tokens. The workflow receives only a short-lived OIDC identity and
the minimum GitHub permissions needed to create the tag and release.

Release evidence belongs in the release notes and Linear ticket. Never paste plaintext
credentials, operation content, or private infrastructure details into either.
