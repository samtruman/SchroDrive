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

Settings keeps retention profiles in SchröDrive while acquisition remains
owned by the configured ARR/Seerr integrations. The profile editor includes
profile-scoped language and rule controls and a read-only `Preview impact`
operation (`POST /api/version-manager/profiles/preview`) that evaluates
unsaved configuration against the latest valid snapshot without persisting it
or rescanning providers.

When Seerr is configured, `GET /api/version-manager/acquisition/arr-profiles`
discovers Radarr and Sonarr instances through Seerr's read-only settings
gateway. It first consumes profiles returned by Seerr itself. If the installed
Seerr version exposes an ARR instance but does not proxy that instance's
profiles, the server-side adapter may perform a read-only fallback against the
declared ARR connection and credentials returned by Seerr; no ARR address,
port, credential, or container name is hardcoded. ARR credentials are never
returned to the Web UI. The response preserves the ARR kind, provider/server
identity, profile identity, and discovery source; the Media Manager stores only
an explicit association on a retention profile. ARR profiles are never
recreated locally. A missing, unavailable, or stale ARR profile is shown with
its actual discovery/mapping state and does not trigger acquisition.
The current acquisition adapter supports Seerr request/status flows, but does
not claim a second physical version for a title when the gateway only exposes
one movie or season request scope; such cases remain explicitly unsupported.

Policy changes are evaluated against the latest valid snapshot immediately;
they do not require another provider inventory scan. The status projection
exposes whether that snapshot was evaluated with the current decision-config
hash or is stale. Missing requirements are derived for every enabled retention
profile; Seerr previews are separately marked unavailable when acquisition is
disabled or the gateway is not configured.

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
UI. The impact response also identifies physical size, alternative KEEP
versions, profile ownership, and ProviderItems protected by a KEEP version;
logical DELETE_CANDIDATE counts must never be interpreted as physical delete
operations. `/api/version-manager/delete-preview` remains a compatibility
read-only policy projection.

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
and retained historically. Incrementals are always compared with the latest
verified FULL baseline, so their `baseBackupId` remains reconstructible even
when another incremental backup was created in between. A removal never erases
an older magnet. A magnet is recovery
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
- Pack preference is persisted and surfaced in Retention settings. The current
  physical impact projection still blocks uncertain or incomplete pack
  coverage; complete multi-season pack preference evaluation remains a
  follow-up before delete execution can be enabled.
- ARR quality profiles are presented as an integration concern when the
  corresponding ARR capability is configured; SchröDrive does not recreate
  ARR custom formats or direct-mode indexer search. Seerr remains the required
  entry point in ARR mode; direct ARR access is only a server-side, read-only
  compatibility fallback using an instance dynamically declared by Seerr.
- Missing selection and exclusion are read-model operations. Real acquisition
  remains explicitly guarded by the existing Seerr/ARR configuration and is
  not enabled by this read-only milestone.
- Browser and provider validation must use isolated fixtures before deployment;
  production data is not modified by these read-only projections.

## Safety contract

Canonical snapshots are never replaced by an invalid or incomplete scan.
Provider readiness is distinct from an empty inventory. Delete Preview,
Review, Missing, Magnet Backup, and migration preview are read-only unless an
explicit migration execution confirmation is submitted. No Delete Executor is
implemented here.
