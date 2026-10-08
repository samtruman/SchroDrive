# Media Manager - upstream proposal

## Proposal summary

This proposal adds a policy-aware Media Manager to SchroDrive. It gives
operators one consistent way to understand the media already present in a
provider, compare multiple releases, identify missing profile requirements,
review uncertain metadata, and safely remove redundant provider items.

The proposal is intentionally provider-neutral. It does not replace existing
provider clients, Radarr, Sonarr, Seerr, or Jellyfin. It adds a persisted
read model and policy engine above those integrations, with explicit actions
for acquisition, review, migration, and deletion.

The core user experience is:

    inventory -> identity -> policy evaluation -> explainable projection
             -> optional, explicitly confirmed action

The important distinction is that a policy decision is not automatically a
destructive action. A scan can classify a release as DELETE_CANDIDATE, but
only the explicit delete endpoint can request deletion, and safety checks run
again immediately before the provider operation.

## Problem

Provider-backed libraries commonly contain:

- several releases of the same movie or episode;
- files with different resolution, language, codec, audio, or source quality;
- season packs mixed with independent episode releases;
- incomplete or conflicting identities;
- content that does not satisfy the configured quality profile;
- files that are missing from the preferred profile but still useful as a
  lower-quality fallback.

Without a canonical model, these cases are difficult to explain and unsafe to
manage. A flat file list cannot distinguish a duplicate from the only copy, a
season pack from unrelated episodes, or an inferior release from a valid
alternative.

The Media Manager addresses this by making identity, policy, physical provider
ownership, and operator actions explicit.

## Proposed design

The feature introduces four cooperating concepts:

1. canonical provider inventory and file fingerprints;
2. identity-first grouping into movies, episodes, and versions;
3. profile-based evaluation with hard requirements and ranking;
4. read-only projections plus guarded explicit actions.

The Web UI reads the same persisted snapshot as the API. It does not create a
second inventory or make decisions that differ from the backend.

## User-visible behavior

The feature exposes four complementary views:

- Library: what exists, grouped by canonical identity and version;
- Policy Missing: what each enabled profile still requires, grouped by title,
  series, season, and episode;
- Review: what cannot be decided safely because identity, metadata,
  recoverability, or policy conditions are uncertain;
- Policy Delete: which physical provider items are redundant and eligible for
  explicit deletion, including retained alternatives and blockers.

Multiple files for one episode are compared even when all are 1080p. A 1080p
release is not discarded simply because the preferred profile targets 2160p.
The preferred resolution remains missing, while an inferior same-resolution
duplicate can still be identified as a deletion candidate.

Language is an eligibility criterion, not merely a sort key. A release with a
required language can therefore be retained over a larger or higher-quality
release that lacks it.

Season packs are evaluated per episode. A pack is one physical deletion unit,
but its individual episodes must actually cover the affected identities.
Incomplete packs cannot be used as a replacement for episodes they do not
contain.

## Safety model

The default delete mode is DRY_RUN. In this mode the selected provider items
are revalidated but the provider delete API is not called.

LIVE deletion is opt-in and requires:

- disabling the persisted dry-run safety flag;
- an unchanged snapshot ID;
- final policy and physical-impact evaluation;
- provider inventory revalidation;
- recoverability and only-copy checks;
- KEEP/protected alternative checks;
- exact confirmation of the selected provider item or batch.

No scan, refresh, policy evaluation, or UI rendering performs a delete.

Acquisition is also explicit. Missing is read-only by default. A request is
sent only when acquisition is enabled, Seerr/ARR mapping is available, the
need is revalidated, and the operator confirms the single request.

## Scope of this proposal

Included:

- provider-neutral inventory and fingerprint model;
- conservative identity resolution and manual identity overrides;
- version profiles, language policies, hard rules, scoring, and ranking;
- 1080p and 2160p comparison, fallback retention, and season-pack analysis;
- Library, Missing, Review, and Delete projections;
- persisted snapshots, policy hashes, audit records, and scan status;
- guarded provider deletion and read-only migration/backup references;
- focused API, UI, and regression tests.

Not included:

- a new torrent search/indexer implementation;
- replacement of provider adapters;
- creation or modification of Radarr/Sonarr profiles;
- provider-specific credentials, mount paths, Compose files, or deployment
  procedures;
- automatic deletion or acquisition triggered by a background scan;
- local media-server library replacement.

## Compatibility and migration

The feature uses existing provider contracts and does not require media bytes to
be copied or renamed. Existing provider items remain the source of truth.
Snapshots can be rebuilt from provider inventory, and migration manifests
contain recovery metadata rather than video content.

When the feature is disabled, existing provider and integration behavior is
unchanged. When enabled, the Media Manager starts with a scan and publishes
projections only after a valid snapshot is available.

## Review guide for maintainers

The most important invariants to review are:

- identity uncertainty must fail closed;
- a partial scan must not replace the last valid snapshot;
- a logical candidate must retain a physical ProviderItem;
- a season pack must be evaluated per episode;
- lower-resolution duplicates must remain comparable;
- required language must outrank size or resolution when configured;
- a DELETE_CANDIDATE must never imply automatic deletion;
- live deletion must be revalidated against current provider inventory;
- provider credentials and deployment-specific paths must not enter the
  generic implementation.

The remainder of this document is the technical reference for the proposal:
data model, lifecycle, policy semantics, API surface, persistence rules,
failure behavior, and test expectations.


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

## Technical reference

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
remain REVIEW unless an operator supplies a valid override. A TV item is also
held for REVIEW when its title is recognized but its season or episode cannot
be determined. It must not be placed directly in a season directory or in a
series-level fallback file. Absolute-numbered anime is the explicit exception
when an absolute episode number is available.

Season and episode numbers are parsed from the release name and path context;
TMDb confirms the series identity and type but does not infer missing episode
numbers. Parser anomalies such as placeholder markers (S00E00) must be
resolved before organization, otherwise the item remains in REVIEW for manual
assignment.

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
- backup, migration preview, and migration job status;
- Audit Cleanup, a read-only report of duplicate source symlinks and equivalent
  organized-folder variants.

Audit Cleanup never removes files, symlinks, provider items, or directories.
Each finding is an operator-review candidate and must be resolved explicitly.

### 10a. Deployment identity

The backend exposes a build record through /api/status and /api/build-info.
The sidebar shows the short build commit above System Online. A deployment may
also provide image, build time, runtime commit, and frontend commit metadata
through the build manifest or environment. Unknown values remain visible as
unknown; they are never inferred from a stale UI bundle.

The build label is diagnostic only. It does not trigger a restart, scan, or
provider action.

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
- deployment-specific orchestration;
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

The consolidated baseline is branch baseline/schrodrive-2026-10-08 at commit d806fe9.
The repository typecheck and the unit/e2e/regression suite passed with 343
tests and 0 failures before this documentation-only follow-up.

The current production image is not a substitute for source validation. Any
future PR must be tested from a clean branch based on the baseline and must
not be considered deployed until source, built frontend, image, Compose
reference, and runtime mounts have been compared.

## Inventory readiness and provider resilience

The Media Manager operates on a detailed provider inventory. A lightweight
provider listing is not sufficient for policy evaluation, duplicate detection,
season-pack analysis, or delete-impact analysis.

During a cold start, the mount may initially have only a lightweight provider
index while detailed file trees are being restored or refreshed. The Media
Manager must therefore expose an explicit inventory state and must not present
partial data as a complete evaluation. It should show progress, pending items,
timeouts, retries, and the timestamp of the last successful detailed scan.

The planned provider inventory architecture uses a persistent incremental index
rather than rebuilding all file trees on every restart:

- provider status and file-tree metadata are persisted under application data;
- the last valid item-level result is retained when a provider request fails;
- new or changed torrents are refreshed in bounded batches;
- detailed file trees can be loaded lazily when an item is opened;
- background reconciliation continues after the HTTP API and mount are ready;
- one provider timeout is isolated from the rest of the inventory.

The Media Manager becomes fully actionable only when the required inventory
scope is ready. This preserves the correctness of Missing, Review, Delete
Candidates, season-pack comparison, and duplicate analysis while keeping the
mount and general SchroDrive UI available during startup.
