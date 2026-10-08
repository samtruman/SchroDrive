# Media Manager

## Feature scope and upstream boundary

The Media Manager is a standalone library-policy and version-management
feature. It consumes provider inventory and existing media-server metadata, but
does not replace the provider clients, ARR bridge, Seerr request flow, or the
media-server libraries. Its purpose is to turn the current provider/file
state into an explainable, reviewable model of what is present, missing,
preferred, redundant, or blocked.

The current fork implementation covers:

- canonical inventory and identity enrichment for movies, series, seasons,
  episodes, season packs, and multiple releases;
- profile-scoped hard requirements, language rules, retention rules, scoring,
  and preference evaluation;
- Library, Policy Missing, Review, and Policy Delete projections;
- grouping of TV content as 'series -> season -> episode -> versions';
- comparison of equivalent versions at the same resolution, including 1080p
  and 2160p, without discarding lower-resolution duplicates before comparison;
- provider-item-aware delete impact analysis, including season-pack
  completeness, incomplete alternatives, protected content, and physical
  delete units;
- read-only previews, persisted snapshots, audit-safe migration references,
  and explicit dry-run safety gates;
- ARR profile discovery through the configured Seerr gateway without
  recreating ARR profiles locally;
- dashboard refresh of recent provider activity followed by organization,
  while the full Version Manager scan remains an explicit, more expensive
  operation.

The feature is deliberately split into two boundaries:

1. generic Media Manager behavior that can be proposed upstream;
2. deployment-specific runtime wiring, provider paths, credentials, mount
   layout, and production integration, which must never be included in an
   upstream PR.

The intended upstream PR for the Media Manager should be assembled from the
current tested baseline as a series of independently reviewable commits. It
must preserve the existing provider and ARR contracts, avoid local deployment
references, and include focused regression tests for every policy projection
that changes.

## Implementation specification

### 1. Purpose

The Media Manager provides an explainable operational view of provider-backed
media. It answers four different questions without conflating them:

1. what physical media exists in the provider inventory;
2. how each file or release is identified and grouped;
3. which version satisfies each configured profile;
4. which content is missing, needs review, can be retained, or is a safe
   physical deletion candidate.

It is a policy and inventory layer. It does not become a second provider
client, a second ARR, or a second media-server library.

### 2. Responsibilities and non-goals

The Media Manager is responsible for:

- reading provider inventory and recursive provider file trees;
- creating a canonical snapshot of media fingerprints and identities;
- evaluating version profiles and retention policy;
- exposing Library, Policy Missing, Review, and Policy Delete projections;
- preserving provider-item identity when several files belong to one torrent;
- making destructive operations explicit, revalidated, and auditable;
- exposing read-only migration and acquisition previews;
- submitting one explicitly confirmed acquisition request through the configured
  Seerr adapter when acquisition is enabled.

It is not responsible for:

- downloading or searching torrents itself;
- creating or modifying Radarr/Sonarr quality profiles;
- replacing Seerr as the request gateway;
- copying video files into the organized library;
- deleting local organized files directly;
- silently deleting provider content during scans, refreshes, policy evaluation,
  or display of a candidate.

### 3. Source of truth and data flow

The canonical flow is:

    Provider inventory
        -> provider file tree
        -> media fingerprint
        -> identity enrichment
        -> persisted VersionManager snapshot
        -> profile evaluation
        -> policy projections
        -> optional explicit action

A ProviderItem is the physical provider-side deletion and recoverability unit.
A media file inside that item is a logical Version. A season pack may contain
many logical Versions but remains one physical deletion unit.

The Web UI consumes the persisted snapshot and policy APIs. It must not invent
a second inventory or silently alter provider state while rendering a view.

### 4. Domain model

- ProviderItem: provider ID, provider item ID, name, status, bytes,
  infohash/recoverability evidence, timestamps, and recursive file tree.
- MediaFingerprint: parsed identity, video properties, audio/subtitle tracks,
  release metadata, storage metadata, provenance, and probe status.
- Version: one media file fingerprint linked to its ProviderItem.
- VersionGroup: versions with the same canonical media identity:
  movie, or series/season/episode identity.
- VersionProfile: a named set of target resolution, language, hard rules,
  scoring, source/codec/audio ordering, size preference, and acquisition
  behavior.
- ProfileEvaluation: eligibility, score, score breakdown, and reasons for one
  VersionProfile.
- VersionDecision: KEEP, DELETE_CANDIDATE, or REVIEW.
- Physical release: one ProviderItem shown as one selectable delete unit. A
  season pack is one physical release containing all linked episodes; separate
  episode ProviderItems remain separate releases.
- Snapshot: an atomically persisted evaluated inventory with ID, creation time,
  policy hash, groups, profiles, and scan metadata.
- Audit record: persisted evidence for scans, acquisition previews/requests,
  deletion attempts, review actions, exports, and migration jobs.

### 5. Inventory and scan lifecycle

A full Version Manager scan:

1. reads the configured provider inventory;
2. expands recursive file trees;
3. fingerprints supported media files;
4. enriches identity and recoverability evidence;
5. evaluates all active profiles;
6. persists a valid snapshot and audit counts.

A scan is asynchronous and single-flight per provider. The UI can start a scan,
poll its status, and open the resulting snapshot. An incomplete or invalid scan
must not replace the last valid snapshot.

The dashboard Refresh action is intentionally lighter than Run Scan. It runs
recent provider reconciliation and organization, then reloads dashboard data.
It does not perform the full Version Manager scan. New files therefore become
visible in the Media Manager decision projections only after Run Scan has
completed, unless a later workflow explicitly applies an incremental snapshot
update.

The provider reconciliation worker is separate from the Version Manager
snapshot. It detects recent provider additions/changes and can route completed
media to Radarr or Sonarr according to the configured movie/TV mapping.

### 6. Identity resolution

Identity resolution is conservative. Strong canonical IDs and explicit manual
overrides take precedence over weak title matching. Evidence may include:

- provider metadata and file-tree context;
- Plex/Jellyfin metadata and provider IDs when configured;
- TMDb search and canonical identity;
- filename parsing as a fallback;
- Radarr/Sonarr parser fallback when explicitly enabled;
- persisted manual identity overrides.

Movie and episode identities are never merged solely because their titles look
similar. Series title, year, season, episode and media kind remain part of the
group key. Ambiguous, conflicting, low-confidence, or missing TMDb identities
remain REVIEW unless an operator supplies a valid override.

The identity picker can search TMDb and apply or clear a manual override. The
override reevaluates the latest cached records and does not start a provider
rescan.

### 7. Policy model

The policy contains enabled VersionProfiles and global safety/acquisition flags.

A profile can define:

- target: QUALITY or DIRECT_PLAY;
- preferred resolution;
- required, preferred, and original audio/subtitle languages;
- required-language action: REVIEW or DELETE_IF_REPLACED;
- source, codec, and audio ordering;
- hard boolean rules using AND, OR, NOT, COMPARE, IN, and HAS;
- scoring weights and structured scoring rules;
- maximum bitrate or size;
- same-resolution size preference: LARGER, SMALLER, or IGNORE;
- minimum percentage difference for size tie-breaking;
- optional season release-group consistency;
- acquisition behavior and read-only ARR profile mapping.

Supported rule fields include resolution, source, codec, bitrate, size, file
size, audio codec/language, subtitle language, channels, Atmos, HDR,
Dolby Vision, container, original language, identity confidence, media type,
and profile eligibility.

The default PRIMARY / QUALITY profile prefers 2160p and orders source, codec,
and audio quality accordingly. The optional REMOTE / DIRECT PLAY profile
targets verified 1080p and is disabled unless remote policy is enabled.

The ranking order is not changed by fallback logic. Language eligibility, hard
requirements, source/codec/audio order, scoring, and configured size preference
remain the governing criteria. Fallback only prevents duplicate lower-resolution
versions from disappearing when the preferred resolution is missing.

### 8. Version decisions

For each VersionGroup and active profile:

- eligible versions are ranked by profile score and configured criteria;
- an unambiguous best eligible version becomes KEEP;
- an unresolved tie remains REVIEW;
- versions that fail identity, hard requirements, recoverability, or metadata
  safety remain REVIEW unless a valid replacement rule applies;
- a version becomes DELETE_CANDIDATE only when another admissible KEEP
  alternative survives and safety rules allow the decision.

The same comparison logic is applied within 2160p and within 1080p. A 1080p
file is not discarded merely because it is below the primary 2160p target:
multiple 1080p releases are compared, and an inferior duplicate can be shown
as a candidate while the primary target remains missing.

Language precedence is part of eligibility, not a cosmetic sort. A release with
the required language can therefore be retained over a larger or higher quality
release that lacks it. Missing required language can produce a candidate only
when DELETE_IF_REPLACED is configured and an admissible replacement is kept.

### 9. Season packs and incomplete alternatives

A season pack is compared at episode level, not by total pack size. Every
episode in the pack must map to the corresponding episode identity and be
evaluated for language, quality, and completeness.

The pack preference setting can prefer a complete pack over incomplete
independent releases, but it cannot authorize deletion of episodes that would
lose the required language or leave an episode without an admissible
alternative. A smaller complete pack can be retained over a larger partial
set, while an incomplete or language-ineligible pack remains review-blocked or
becomes a candidate only when every affected episode has a safe replacement.

The UI groups the physical pack as one deletion selection while preserving
episode-level explanations. It must never show a pack as a replacement for
episodes that it does not contain.

### 10. UI projections and actions

The Media Manager UI exposes:

- Library: all canonical groups with movie/TV, title, profile, decision,
  multiple-version, and attention filters;
- Policy Missing: profile requirements grouped by title, series, season, and
  episode, with current files and missing target information;
- Review: identity, policy, recoverability, and organizer review items, with
  pending/dismissed/all and issue filters;
- Policy Delete: physical deletion candidates, retained alternatives,
  protected releases, blockers, season-pack membership, and explicit selection;
- profile/settings editor: language policy, rules, scoring, retention, safety,
  remote/acquisition behavior, and ARR mappings;
- scan status and snapshot/evaluation freshness indicators;
- backup, migration preview, and migration job status.

Review and Missing support dismiss/restore state. Dismissal hides an item from
the pending queue; it does not delete a provider item or alter inventory.
Manual identity actions affect cached evaluation only and are auditable.

### 11. Acquisition and ARR integration

Missing is a read-only projection by default. It can show a Seerr preview and
mapping status without sending a request. An explicit acquisition request
requires:

- a valid single missing need;
- configured acquisition request enablement;
- a configured Seerr adapter;
- a revalidation/status check;
- explicit REQUEST_ONE confirmation.

ARR profiles are discovered read-only through Seerr or its declared ARR
connection. SchroDrive stores the association but does not recreate profiles
or alter Radarr/Sonarr configuration. Movie requests map to Radarr and TV
requests to Sonarr. Provider reconciliation uses configured ARR endpoints only
for import/update routing and remains separate from policy evaluation.

### 12. Delete execution and safety

Delete impact is provider-aware and read-only until an explicit execute call.
The Delete Executor supports one ProviderItem or a batch, with:

- snapshot ID matching;
- final policy and physical-impact revalidation;
- provider inventory drift detection;
- only-copy and KEEP-protection checks;
- recoverability requirements;
- exact single-item or batch confirmation;
- audit records for validated, deleted, failed, and stale selections.

The persisted safety default is deleteDryRun=true. DRY_RUN validates the
selection without calling the provider delete API. LIVE mode is opt-in by
setting deleteDryRun=false and confirming exact IDs. The provider delete
operation removes the confirmed provider torrent/item; it is not a local file
unlink operation and is never triggered by a scan or refresh.

After successful deletion, the UI applies the snapshot delta and reloads the
affected projections. If provider inventory changed, no additional item is
deleted and the user must refresh and select again.

### 13. Backup and migration

Exports and Magnet Backup preserve recovery evidence, not video bytes. A
manifest can include provider IDs, magnet/infohash evidence, file-tree metadata,
identity associations, and profile associations without credentials or local
absolute paths.

FULL and INCREMENTAL backups are checksummed and retained. Incrementals point
to the latest verified FULL baseline. Migration preview is read-only. Explicit
migration jobs are asynchronous, persisted, single-flight per source/target,
resume-aware, and never delete from the source provider.

### 14. API surface

Core lifecycle and projections:

- POST /api/dashboard/refresh
- GET /api/version-manager/providers
- GET /api/version-manager/status
- POST/GET /api/version-manager/scan and GET /api/version-manager/scan/:id
- GET /api/version-manager/preview
- GET /api/version-manager/missing
- GET /api/version-manager/review
- GET /api/version-manager/delete-preview
- GET /api/version-manager/delete
- GET /api/version-manager/delete/history

Policy and identity:

- PUT /api/version-manager/profiles
- POST /api/version-manager/profiles/preview
- GET /api/version-manager/identity/search
- POST /api/version-manager/identity/override
- POST /api/version-manager/review/:key
- POST /api/version-manager/missing/:key

Actions and migration:

- POST /api/version-manager/acquisition/request
- POST /api/version-manager/delete/execute
- POST /api/version-manager/delete/execute-batch
- POST /api/version-manager/snapshot/apply-deletion
- GET/PUT/POST /api/version-manager/magnet-backup and GET/DELETE
  /api/version-manager/magnet-backup/:id
- GET /api/version-manager/export
- GET /api/version-manager/migration/state
- GET /api/version-manager/migration/capabilities
- POST /api/version-manager/import/preview
- POST /api/version-manager/import/execute and /execute-bulk
- POST/GET /api/version-manager/migration/jobs and GET /jobs/:id

Next.js API routes proxy these backend endpoints. They must preserve status
codes, error bodies, read-only flags, snapshot IDs, and confirmation semantics.

### 15. Persistence and consistency rules

- Provider inventory and evaluated snapshots are persisted in the configured
  data store.
- Snapshots are replaced atomically only after successful completion.
- Every projection identifies its provider and snapshot where relevant.
- A stale policy hash is reported instead of silently presenting an evaluation
  as current.
- A changed snapshot invalidates an execution request.
- Audit records are append-oriented and must not contain provider credentials.
- Temporary test output, production env files, runtime databases, and local
  mount paths are not source-controlled.

### 16. Failure behavior

The system must fail closed when:

- no configured provider exists;
- no valid snapshot exists;
- provider readiness is unavailable;
- identity confidence is insufficient;
- metadata or recoverability is required but unknown;
- a delete snapshot is stale;
- a selected ProviderItem disappeared;
- a pack is incomplete for the affected episode;
- an acquisition mapping or Seerr request cannot be revalidated.

A failure must not be represented as an empty inventory, and a partial scan
must not erase the last valid snapshot.

### 17. Upstream PR boundary

The standalone Media Manager PR should contain the generic model, policy
engine, projections, safety rules, tests, and provider-neutral API contracts.
It must exclude:

- production Compose files and runtime overrides;
- deployment-specific mount paths;
- credentials, tokens, API keys, and real media filenames;
- CineCircle-specific orchestration;
- local Portainer or server procedures;
- unrelated provider reconciliation or dashboard deployment changes.

The PR should be split into reviewable commits where practical:

1. canonical inventory and identity model;
2. policy profiles and evaluation;
3. Library/Missing/Review projections;
4. Delete impact and guarded executor;
5. backup/migration references;
6. Web UI and API proxy routes;
7. focused regression tests and documentation.

### 18. Validation status

The consolidated baseline is tagged baseline-2026-10-08 at commit 7db43c5.
The repository typecheck and the unit/e2e/regression suite passed with 340
tests and 0 failures before the documentation-only follow-up commit.

The current production image is not a substitute for source validation. Any
future PR must be tested from a clean branch based on the baseline and must
not be considered deployed until source, built frontend, image, Compose
reference, and runtime mounts have been compared.

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

The /api/version-manager/delete endpoint is the physical delete-unit impact
projection. It groups versions by the provider item that an adapter can
actually delete, reports affected content, only-copy status, recoverability
blockers, and whether the item is partially redundant. The Delete Executor is
enabled and is exposed through single-item and batch endpoints. The impact
response also identifies physical size, alternative KEEP versions, profile
ownership, and ProviderItems protected by a KEEP version; logical
DELETE_CANDIDATE counts must still not be interpreted as an instruction to
delete automatically. The /api/version-manager/delete-preview endpoint
remains a compatibility read-only policy projection.

Delete execution defaults to DRY_RUN through the persisted safety setting
`deleteDryRun`. In DRY_RUN the selected ProviderItems are fully revalidated but
the provider delete method is not called. LIVE execution requires explicitly
disabling that safety setting and supplying the exact confirmation for the
selected ProviderItem or batch. The executor then revalidates the snapshot,
checks provider inventory drift, protects KEEP alternatives, and deletes only
the confirmed provider torrent/item.

The `preferCompletePack` setting is persisted as a policy preference for future pack-aware
impact evaluation. Pack completeness must be checked per episode before it
can authorize a physical deletion; incomplete or uncertain packs remain
review-blocked even when live execution is enabled.

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

- LIVE delete execution is intentionally opt-in. DRY_RUN remains the default,
  and every live operation requires final revalidation and explicit
  confirmation.
- Automatic backup scheduling is disabled by default. When enabled it uses the
  existing process scheduler, the configured Europe/Rome timezone by default,
  and configurable retention values; it never adds a cron container.
- Pack preference is persisted and surfaced in Retention settings. Pack
  completeness is evaluated per affected episode; uncertain or incomplete
  coverage remains blocked from automatic deletion.
- ARR quality profiles are presented as an integration concern when the
  corresponding ARR capability is configured; SchröDrive does not recreate
  ARR custom formats or direct-mode indexer search. Seerr remains the required
  entry point in ARR mode; direct ARR access is only a server-side, read-only
  compatibility fallback using an instance dynamically declared by Seerr.
- Missing is a read-only projection by default. A real acquisition request
  is available only when explicitly enabled, mapped through Seerr, revalidated,
  and confirmed with REQUEST_ONE.
- Browser and provider validation must use isolated fixtures before deployment;
  production data is not modified by these read-only projections.

## Safety contract

Canonical snapshots are never replaced by an invalid or incomplete scan.
Provider readiness is distinct from an empty inventory. Delete Preview,
Review, Missing, Magnet Backup, and migration preview are read-only. Delete
execution is a separate explicit operation, protected by the persisted
DRY_RUN setting, exact ProviderItem confirmation, snapshot matching, provider
inventory revalidation, and KEEP/only-copy safety checks. No delete is
triggered by a scan, refresh, policy evaluation, or display of a
DELETE_CANDIDATE.
