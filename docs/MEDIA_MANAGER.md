# Media Manager

## Architecture

The Media Manager is a read model over the existing provider and policy
services. A configured `DebridProvider` produces `ProviderItem` records and
their provider file trees. The canonical inventory turns real media files
into `MediaFingerprint` records, `Version` records, and `VersionGroup`
records. Identity enrichment and policy evaluation operate on that persisted
snapshot; the Web UI does not create a second inventory engine.

Library, Missing, Review, and Delete read from the valid canonical snapshot.
Review is a deduplicated projection and may contain overlapping identity,
policy, and recoverability reasons. Missing acquisition previews are only
generated when the REMOTE policy is enabled.

## Library

Library supports movie and TV scopes, search, decision/profile filters,
multiple-version and attention filters, title/version sorting, and a compact
hierarchy for canonical TV identities:

`series -> season -> episode -> versions`.

Unresolved identities remain separate and are labelled unresolved. The
projection does not change inventory cardinality or policy decisions. Version
details come from the existing fingerprint and provider-file metadata; an
unknown field is displayed as unavailable rather than inferred.

## Delete

`/api/version-manager/delete` is a read-only physical delete-unit impact
projection. It groups versions by the provider item that an adapter can
actually delete, reports affected content, only-copy status, recoverability
blockers, and whether the item is partially redundant. The executor is
explicitly disabled in this milestone; no provider delete is exposed by the
UI. `/api/version-manager/delete-preview` remains a compatibility read-only
policy projection.

`preferCompletePack` is persisted as a policy preference for future pack-aware
impact evaluation. Pack completeness must be checked per episode before it
can authorize a physical deletion; incomplete or uncertain packs remain
review-blocked.

## Backup & Migration

The existing `MigrationManifest` is the canonical lightweight reference
format. Export stores magnet/infohash evidence, provider metadata, file-tree
metadata, identity associations, and version/profile associations without
copying media bytes.

Magnet Backup uses the same exporter through:

- `GET /api/version-manager/magnet-backup`
- `POST /api/version-manager/magnet-backup` with `FULL` or `INCREMENTAL`
- `GET /api/version-manager/magnet-backup/:id`

Backups are written atomically under the configured data directory, checksummed
and retained historically. Incrementals preserve added, modified, and removed
references; a removal never erases an older magnet. A magnet is recovery
evidence, not a guarantee that the content remains available.

The existing migration preview and importer are reused. Explicit migration
execution is available only through a confirmed asynchronous job:

- `POST /api/version-manager/migration/jobs` with `START_MIGRATION`
- `GET /api/version-manager/migration/jobs`
- `GET /api/version-manager/migration/jobs/:id`

The job is persisted, single-flight for a source/target pair, survives browser
disconnects, reuses per-item revalidation and audit records, and never deletes
from the source provider. Provider credentials and runtime identifiers are
not written to documentation.

## UAT safeguards

Scan progress is persisted through identity enrichment. Review clears a stale
error after a successful retry. Migration dashboard values distinguish loading,
unavailable/unconfigured provider state, not-calculated state, and an actual
zero. Export remains source-only; migration state requires a configured target
because it reconciles against target inventory.

## Current limitations

- Physical delete execution remains disabled and requires a separate explicit
  milestone.
- Automatic backup scheduling is disabled by default. When enabled it uses the
  existing process scheduler, the configured Europe/Rome timezone by default,
  and configurable retention values; it never adds a cron container.
- Pack preference is persisted and surfaced. Uncertain or incomplete pack
  coverage remains blocked until a complete per-episode impact plan exists.
- Browser and provider validation must use isolated fixtures before deployment;
  production data is not modified by these read-only projections.

## Safety contract

Canonical snapshots are never replaced by an invalid or incomplete scan.
Provider readiness is distinct from an empty inventory. Delete Preview,
Review, Missing, Magnet Backup, and migration preview are read-only unless an
explicit migration execution confirmation is submitted. No Delete Executor is
implemented here.
