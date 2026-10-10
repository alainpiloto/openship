# Project migration preflight

`GET /api/projects/:id/migration-status?revision=<40 lowercase hexadecimal Git SHA>`

Self-hosted only (`localOnly` means the OpenShip SaaS does not serve this operation;
an HTTPS client running in Codex Cloud can call a self-hosted instance). Uses the
existing authenticated `project:read` route and the platform's resource authorization.
No new token permissions. Read-only tokens retain all deploy/service-exec/server-exec
denials. Request fields are closed: no command, DSN, SQL, cwd, executable, or manifest
is accepted from the client. SDK: `ship.projects.getMigrationStatus(id, { revision })`.
Responses are `Cache-Control: no-store` and wrapped in `{ "data": ... }`.

Example complete observation:

```json
{
  "data": {
    "projectId": "synthetic-project",
    "organizationId": "synthetic-org",
    "status": "PENDING",
    "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "deploymentId": "synthetic-deployment",
    "activeRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "manifestDigest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "checkedAt": "2026-10-09T16:00:00.000Z",
    "counts": { "expected": 2, "applied": 1, "pending": 1, "failed": 0, "divergent": 0 },
    "reason": "COMPLETE"
  }
}
```

All responses have exactly these fields. Status is `UP_TO_DATE`, `PENDING`, `FAILED`,
`DIVERGED`, or `UNKNOWN`. Reasons are `COMPLETE`, `PROFILE_UNAVAILABLE`,
`MANIFEST_UNAVAILABLE`, `BUSY`, or `INDETERMINATE`. UNKNOWN has null deployment,
active revision, digest and all counts. `checkedAt` is the server's completion time,
not a cached result; the transaction observes a history snapshot within the bounded
check. This is a point-in-time preflight, not a lock on subsequent deployments or
migration application. No migration names, SQL, logs, stdout/stderr, connection
strings, environment, or business rows are returned.

Client acceptance must require: expected project AND organization, exact requested
candidate SHA, expected candidate digest, nonempty active deployment/revision,
fresh parseable timestamp, `reason=COMPLETE`, `status=UP_TO_DATE`, integer complete
counts, `expected=applied`, and pending/failed/divergent all zero. Compare active
revision with separate deployment evidence as required by the release gate.
Every other response, transport/authorization/schema failure, or mismatch closes
the gate. Never fall back to arbitrary exec. Candidate and active revision can differ:
the endpoint compares the reviewed candidate's migration manifest with the active
runtime's database, not just the active runtime's migration files.

## Operator-reviewed profiles and exact manifests

Disabled by default. Before publishing, provision `OPENSHIP_MIGRATION_PROFILE_DIR`
as an absolute controller-local directory owned by the operator, outside project
workspaces and application container mounts. Protect it and all parent directories
from project users; do not use symlinked/writable parents. Each `<projectId>.json`
is a regular non-symlink file, owned by the API user or root, not group/world writable,
with a maximum size of 1 MB. This is operator configuration, not an HTTP write API.
Review the runtime image and installed generated Prisma client before binding its
exact commit as `runtimeRevision`. A redeploy to another commit closes the gate until
its runtime profile is reviewed. Do not add credentials to these files.

```json
{
  "version": 1,
  "profile": "prisma-postgresql-v1",
  "projectId": "synthetic-project",
  "organizationId": "synthetic-org",
  "runtimeRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "manifests": [
    {
      "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "migrations": [
        {
          "name": "001_init",
          "checksum": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        }
      ]
    }
  ]
}
```

Generate candidate manifests with:

```sh
node scripts/migration-status-manifest.mjs /path/to/reviewed/repository <full-sha>
```

The tool reads Git objects only; it does not check out or execute repository code.
Only regular `prisma/migrations/<name>/migration.sql` files are accepted. Each
checksum is SHA-256 over the exact Git blob bytes (no newline normalization).
Review repository identity, candidate SHA and migration directory before provisioning.
A digest alone cannot establish repository provenance; trust comes from this reviewed
operator provisioning. This first version does not automatically fetch/build candidate
revisions, and has no profile mutation endpoint.

Digest algorithm (v1): SHA-256 of UTF-8 `JSON.stringify({ revision, migrations })`,
without whitespace/newline. `migrations` are sorted by ASCII name ascending; each entry
is created in key order `{ name, checksum }`. Hex strings are lowercase. The server
normalizes schema key order before hashing. Duplicate or unsorted migration names and
multiple manifests for one revision are indeterminate. Limits: 100 manifests per profile,
1000 migrations per manifest/history, migration names `[A-Za-z0-9_-]{1,200}`.

## Execution boundary and limitations

V1 supports a standalone Docker project, including one with zero service rows.
The validated active deployment resolves the runtime. A live running container must
match the recorded immutable ID AND `openship.project`/`openship.deployment` labels.
No container name guessing, sidecar fallback, host execution, or runtime provisioning.
Compose/multiple-service releases, non-isolated runtimes, runtimes without live
container enumeration, missing labels, missing clients, non-PostgreSQL providers,
custom Prisma output/schema/table locations, and adapter-required Prisma clients are
UNKNOWN. The fixed reviewed profile loads `/app/node_modules/@prisma/client` and
queries `public._prisma_migrations`; it does not call project package scripts or download
Prisma. This profile is verified with the generated native Prisma 6 client and the
NeuroFlow worker's native Prisma 5.22 client in an isolated Docker integration.

The fixed probe uses a read-only transaction, 5-second PostgreSQL statement limit,
6-second Prisma transaction limit, 1-second connection wait, 8-second child lifetime,
10-second executor deadline, and 15-second request deadline. It selects only name,
checksum, and finished/rolled-back booleans, at most 1001 rows (overflow is UNKNOWN).
Errors produce a fixed unknown marker; stderr is discarded. Raw results remain internal
and are capped at 300 KB after transfer. A reviewed generated client is part of the trust
boundary; this is not a sandbox for untrusted application code. Four checks maximum per
API process, one per project, with a 5-second start throttle. Admission remains occupied
until actual work settles after an HTTP deadline. Multi-process installations have separate
limits; configure gateway rate limiting as needed before deployment.

History comparison ignores rolled-back attempts, rejects unknown/changed checksums,
duplicate live records or holes in the applied candidate prefix, and reports unfinished live attempts.
Applied migrations are identified by name and checksum, independent of their historical
`started_at` order. This matches Prisma 5.22's [history diagnosis](https://github.com/prisma/prisma-engines/blob/5.22.0/schema-engine/core/src/commands/diagnose_migration_history.rs): chronological database order alone does not establish divergence.
A complete safe prefix yields PENDING; a complete identical history yields UP_TO_DATE.
Divergence takes precedence over failures. Invalid/incomplete evidence yields UNKNOWN.
Deployment pointer/commit/container/status are revalidated after probing. There is no
persistent successful-result cache and no application/database mutation.

## Review and publication gates

Review the API/product diff and synthetic tests before publication. Local fixtures do
not establish the served revision or Cloud acceptance. Publication needs authorization:
build the API artifact, deploy it through the existing operator workflow, provision
reviewed profiles/manifests without secrets, then verify readback with the existing
scoped read token. From a new Codex Cloud environment, verify HTTPS success for its
own project, rejection of another project/identity, closed query fields, and continuing
read-only deployment/exec denial without issuing real mutations. Verify fail-closed
PENDING/FAILED/DIVERGED/UNKNOWN via synthetic fixtures. Prove the active API artifact
revision; do not infer it from source HEAD or CLI version. No SSH keys or extra server
permissions belong in Cloud. NeuroFlow's adapter remains a separate change.
