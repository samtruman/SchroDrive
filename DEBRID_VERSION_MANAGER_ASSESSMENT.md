# Debrid Version Manager — Assessment

Status: assessment completed, read-only inventory validated, no provider delete performed.

Branch: `feature/debrid-version-manager-assessment`

Date: 2026-09-28

## 1. Executive summary

The feature is technically feasible as a native SchröDrive capability and does
not require a CineCircle-specific design. The recommended implementation is an
internal, provider-neutral module (option B) integrated into SchröDrive's
backend and Web UI (option A at the product boundary).

The core must not be a global "best release" sorter. It should evaluate each
`VersionProfile` independently, group decisions by normalized content identity,
and emit `KEEP`, `DELETE_CANDIDATE`, or `REVIEW` together with structured
explanations.

The first milestone should be read-only:

```text
provider inventory -> normalized fingerprint -> identity -> version groups
-> profile eligibility -> profile scores -> decision + explanation -> UI review
```

No provider deletion is required for this milestone. The future delete executor
must be a separate, explicitly authorized boundary.

The current production inventory was queried through SchröDrive's read-only
API. It contained 417 AllDebrid items, of which 404 were finished. The API
currently exposes provider status, name, size and dates, but not a complete
audio/video fingerprint. That makes a cached `ffprobe` stage the appropriate
optional enrichment layer.

## 2. Current SchröDrive architecture

Relevant existing pieces in this repository:

| Area | Existing implementation | Assessment |
| --- | --- | --- |
| Provider abstraction | `src/providers/index.ts`, `src/providers/registry.ts` | Strong foundation. `DebridProvider` already normalizes torrent, file, status, size and provider operations. |
| AllDebrid | `src/providers/alldebrid.ts` | Existing status/file-tree integration, normalized `TorrentInfo`, rate-limit handling and provider-specific raw data. |
| Inventory API | `src/server.ts`, `GET /api/torrents` | Reusable read-only entry point; needs a Version Manager projection rather than exposing raw provider objects. |
| Persistence | `src/core/db.ts` | SQLite migrations are already used for durable state and are suitable for fingerprints, groups, decisions and audit records. |
| Media parsing | `src/services/mediaParser.ts` | Existing filename identity parser with confidence/status concepts; useful fallback, not sufficient as the sole identity authority. |
| Organizer | `src/services/organizer.ts` | Symlink-based organization and mount-aware filesystem behavior already exist. It should not own policy decisions. |
| Organizer Review | `src/services/organizerReview.ts`, `/api/organizer/review` | Existing persisted review/audit pattern can be reused conceptually and possibly structurally. |
| Provider reconciliation | `src/services/providerReconciliation.ts` and runtime | Existing provider-neutral polling/snapshot/diff boundary is reusable for inventory refresh, but it is not a version policy engine. |
| Media servers | `src/integrations/plex.ts`, `src/integrations/jellyfin.ts`, `src/services/cloudLinks/plexIntegration.ts` | Existing optional refresh/watchlist integrations. They should be optional enrichment/compatibility inputs, not required dependencies. |
| Web UI | `web/src/app/(dashboard)/...` | Existing Next.js dashboard with Overview, Torrents, Review, Logs, Mounts, Services and Settings. A Version Manager section can be added without a new service. |
| Configuration | `src/core/config.ts`, `src/core/configApi.ts` | Existing environment/config schema is useful for safe defaults, but profiles/rules belong in persisted application config exposed by API/UI rather than YAML editing. |

The current active runtime was checked read-only on 2026-09-28: SchröDrive,
Seerr, Prowlarr, Radarr, Sonarr, Plex and Jellyfin were running; Riven and
DavDebrid were not operational dependencies. No production configuration was
changed.

## 3. Debrid Media Manager analysis

Repository inspected: `debridmediamanager/debrid-media-manager`.

Useful implementation areas:

| File/area | Observed behavior | Relevance |
| --- | --- | --- |
| `src/utils/fetchTorrents.ts` | Provider-specific fetchers normalize library entries into `UserTorrent`; AllDebrid is fetched separately and persisted client-side. | ADAPT the normalized inventory idea, not the provider-specific client code. |
| `src/utils/libraryFilters.ts` | Filters status, service, media type, title, hash, `sameTitle` and `sameHash`; title grouping uses normalized titles. | REFERENCE ONLY for discovery filters. It is not sufficient for identity-safe version grouping. |
| `src/utils/torrentInfo.ts`, `src/utils/torrentFile.ts` | Torrent/file representations include provider identity, hash, files, sizes and metadata derived from provider responses. | ADAPT the separation between torrent and file records. |
| `src/utils/deleteTorrent.ts` | Provider-specific destructive handlers for RD, AD, TorBox, Premiumize, Offcloud and Debrid-Link. | REFERENCE ONLY for the future delete adapter; do not call in V1. |
| `src/pages/library.tsx`, `src/components/LibraryTorrentRow.tsx` | Library table, filters, selection and explicit delete controls. | REFERENCE ONLY for interaction patterns; Version Manager needs profile-aware review instead of a delete-first UI. |
| `src/services/allDebrid.ts` and `src/utils/allDebridStatus.ts` | AllDebrid API/status helpers and file representations. | REFERENCE ONLY/ADAPT concepts; SchröDrive already has its own AllDebrid adapter. |
| Prisma models and `src/torrent/db.ts` | Client-side cached torrent records and local UI state. | REFERENCE ONLY; SchröDrive should use its existing SQLite persistence. |

DMM's grouping is primarily title/hash oriented. That is useful for surfacing
possible duplicates, but it does not distinguish a primary 2160p remux from a
remote-friendly 1080p WEB-DL as separate policy satisfiers. DMM's delete path
also demonstrates why deletion must be isolated behind explicit confirmation
and provider-specific adapters.

### DMM license

The inspected repository contains the GNU Affero General Public License,
version 3. Code reuse would carry AGPL obligations and should not be copied
into SchröDrive without an explicit license decision. For this proposal:

- REUSE: none of DMM's code directly;
- ADAPT: data-model and UI concepts only;
- REIMPLEMENT: grouping/policy logic in SchröDrive;
- REFERENCE ONLY: delete and provider API patterns.

## 4. Zurg analysis

Repository inspected: `debridmediamanager/zurg-public`.

The public repository is primarily configuration, Docker, scripts and public
documentation. The core binary/source implementation is not present in the
checkout inspected. Therefore conclusions about internal algorithms are based
only on the public configuration surface and scripts, not on unavailable
private implementation code.

Useful concepts:

| Area | Observed behavior | Relevance |
| --- | --- | --- |
| `config.yml` / public config documentation | Flexible filtering by name, file contents, size, age and other conditions; nested provider/library configuration. | REFERENCE ONLY for a declarative rule model. |
| `auto_analyze_new_torrents` | Public configuration enables `ffprobe` analysis for newly added torrents. | ADAPT the staged probe/cache concept; use SchröDrive-owned records and bounded work. |
| provider/library filtering | Zurg presents provider data through a mount and applies selection/filtering before media-server exposure. | REFERENCE ONLY; Version Manager must not make mount exposure destructive. |
| Plex/Jellyfin/Emby settings | Public configuration supports server URLs/tokens and library update hooks. | ADAPT optional library refresh integration, but do not require a media server for scoring. |
| cache/network-test settings | Public configuration emphasizes cached results and resilient mount behavior. | ADAPT cache invalidation and stale-data markers for inventory/probe results. |
| public CLI | Includes destructive `clear-downloads` and `clear-torrents` commands. | REFERENCE ONLY for future executor boundary; explicitly excluded from V1. |

The requested nested `AND`/`OR`/`NOT` rule model is consistent with the public
Zurg configuration direction, but SchröDrive should implement a typed AST with
validation rather than importing or copying undocumented Zurg internals.

### Zurg license

No explicit `LICENSE`/`COPYING` file was present in the inspected public
checkout. The public repository therefore cannot be treated as a safe source
for code reuse. Use its public behavior and configuration as REFERENCE ONLY;
REIMPLEMENT the rule and analysis abstractions independently. A future legal
review is required before copying any implementation from non-public artifacts.

## 5. vibeDebrid analysis

Repository inspected: `vibeMonarch/vibeDebrid`.

Useful implementation areas:

| File/area | Observed behavior | Relevance |
| --- | --- | --- |
| `src/core/filter_engine.py` | Three-tier model: hard reject, quality scoring, then queue/retry handling. Produces a score breakdown and rejection reason. | ADAPT the separation of hard requirements from scoring and the explanation breakdown. |
| `src/config.py` (`QualityProfile`, `FiltersConfig`) | Configurable resolution, codec, audio, source, size limits, language preferences, original-language behavior and cached bonus. | REFERENCE/ADAPT the configuration shape, but split policies per Version Profile. |
| `src/services/torrent_parser.py` | Pure filename parsing helpers for episodes, packs, languages, dual audio and release tokens. | REFERENCE/ADAPT parsing ideas; use SchröDrive's parser and add normalized fingerprint fields. |
| `src/core/mount_scanner.py`, `src/core/symlink_manager.py` | Mount-first and symlink-oriented library workflow. | REFERENCE ONLY; do not couple policy decisions to symlink creation. |
| templates/API | Existing duplicate management and web configuration patterns. | REFERENCE ONLY for UX; Version Manager needs explainable profile slots. |

vibeDebrid is the closest conceptual reference because it explicitly separates
hard filtering from a score breakdown and supports multiple quality profiles.
Its filter engine is still primarily acquisition-oriented: seeders, cache
status and scrape metadata are important there, while a library Version
Manager should score already-existing versions and must preserve multiple
valid objectives.

### vibeDebrid license

The inspected repository is Apache License 2.0. It is legally more reusable
than AGPL code, but direct copying is still unnecessary and would introduce
unwanted coupling. For this proposal:

- REUSE: none directly;
- ADAPT: tiered evaluation, score breakdown and profile configuration concepts;
- REIMPLEMENT: the fingerprint, grouping and decision engine;
- REFERENCE ONLY: parser and acquisition-specific filters.

## 6. Comparative matrix

| Capability | DMM | Zurg public surface | vibeDebrid | SchröDrive proposal |
| --- | --- | --- | --- | --- |
| Provider abstraction | Multiple provider clients | Provider/mount abstraction | Primarily Real-Debrid/Zurg workflow | Existing `DebridProvider`; normalize once |
| Library inventory | Yes | Yes, through mount/config | Yes, mount scanner | Add persisted read-only inventory projection |
| Grouping | Normalized title/hash | Filtered mount/file views | Title similarity and torrent dedup | Identity-first Content → VersionGroup → Version |
| Media probe | Provider/file metadata | `ffprobe` on new torrents | Filename/parser metadata | Optional `ffprobe` worker with cached status |
| Hard requirements | Basic filters/status | Declarative filters | Strong Tier 1 hard rejects | Typed profile eligibility gates |
| Scoring | Not policy-profile based | Filter selection | Composite score + breakdown | Separate PrimaryScore/RemoteScore per profile |
| Language model | Metadata/provider dependent | Filter/config dependent | Ordered preferred languages | Required ANY/ALL + preferred + ORIGINAL |
| Direct Play | Not the central model | Media-server integration | General media-serving workflow | Conservative compatibility capability model |
| Explainability | UI grouping/actions | Filter behavior | Rejection reason/breakdown | Structured reason codes + human explanation |
| Delete | Explicit provider actions | Destructive CLI actions | Cleanup/management concepts | Dry-run candidate first; separate executor later |
| UI | Mature library page | Config dashboard | Settings/dashboard | Add Version Manager to existing Next dashboard |

## 7. MediaFingerprint

The canonical internal model should be provider-neutral and version-oriented:

```ts
type MediaFingerprint = {
  identity: {
    tmdbId?: string;
    imdbId?: string;
    tvdbId?: string;
    kind: 'movie' | 'series' | 'season' | 'episode' | 'unknown';
    season?: number;
    episodes?: number[];
    originalLanguage?: string;
    confidence: number;
    source: 'provider' | 'metadata' | 'filename' | 'probe' | 'manual';
  };
  video?: {
    width?: number;
    height?: number;
    resolution?: string;
    codec?: string;
    bitrate?: number;
    bitDepth?: number;
    hdr10?: boolean;
    hdr10Plus?: boolean;
    dolbyVision?: boolean;
    dolbyVisionProfile?: string;
  };
  audio: Array<{
    language?: string;
    codec?: string;
    channels?: number;
    bitrate?: number;
    atmos?: boolean;
    isDefault?: boolean;
  }>;
  subtitles: Array<{ language?: string; format?: string; forced?: boolean }>;
  release?: {
    source?: 'REMUX' | 'BLURAY' | 'WEB-DL' | 'WEBRIP' | 'HDTV' | 'UNKNOWN';
    group?: string;
    edition?: string;
  };
  storage: {
    provider: string;
    torrentId: string;
    hash?: string;
    fileId?: string;
    path: string;
    size?: number;
    addedAt?: string;
  };
  probe: {
    status: 'not_requested' | 'queued' | 'complete' | 'failed' | 'stale';
    tool?: 'ffprobe' | 'provider' | 'filename' | 'manual';
    observedAt?: string;
    error?: string;
  };
};
```

Acquisition order:

1. provider status/file tree: IDs, paths, sizes, status and dates;
2. filename/release parser: provisional source, resolution, languages and
   season/episode markers;
3. TMDb/TVDb/IMDb metadata lookup: identity and original language;
4. `ffprobe`: actual streams, codec, dimensions, bitrate, HDR and container;
5. optional Plex/Jellyfin probe: observed library identity only, never a hard
   dependency for the engine.

`MediaInfo` is not necessary for the first milestone if `ffprobe` provides the
required fields. It can be an optional adapter later when a field is proven
unavailable or inconsistent in real files.

## 8. Identity Engine

Identity must be independent of filename similarity.

Resolution order:

1. stable provider-attached metadata, if it already contains a trusted media
   identity;
2. TMDb/IMDb/TVDb IDs from existing records or metadata lookup;
3. parsed title/year/season/episode candidate matching;
4. filename token similarity only as a bounded fallback;
5. `REVIEW` when confidence is below the policy threshold.

The result should classify relationships as:

- `DUPLICATE`: same content identity and same effective media item, with no
  meaningful version distinction;
- `ALTERNATIVE_VERSION`: same content identity but materially different source,
  quality, language, audio, resolution or direct-play characteristics;
- `DIFFERENT_CONTENT`: identity mismatch or insufficient evidence to group.

TV rules must preserve series, season, episode and multi-episode ranges. A
season pack may be a container for multiple episode versions, not a duplicate
of every individual episode without explicit expansion logic.

## 9. Version Groups

The persisted relationship is:

```text
Content(identity)
  └── VersionGroup(content identity + scope)
        └── Version(fingerprint + storage reference)
```

The group scope should be an episode range for TV, a movie identity for films,
and an explicit season-pack scope when a pack cannot be safely expanded.

The same group can satisfy multiple profiles. It must never collapse versions
merely because normalized titles match.

## 10. Version Profiles

The profile model should be persisted and extensible:

```ts
type VersionProfile = {
  id: string;
  name: string;
  enabled: boolean;
  target: 'QUALITY' | 'DIRECT_PLAY' | string;
  preferredResolution?: string;
  hardRequirements: RuleGroup;
  scoringPolicy: ScoringPolicy;
  languagePolicy?: LanguagePolicy;
};
```

Default profiles:

- `PRIMARY` / `QUALITY`: prefer high resolution, source quality and audio;
  file size is not intrinsically negative;
- `REMOTE` / `DIRECT_PLAY`: optional; prefer a compatible, bandwidth-efficient
  version, not merely the highest-scoring 1080p release.

The UI must allow both profiles to be disabled, edited, duplicated and extended
with future targets.

## 11. Language policies

The model must use lists, never a scalar `required_language` field:

```ts
type LanguagePolicy = {
  required: { values: string[]; mode: 'ANY' | 'ALL' };
  preferred: string[];
  original: { enabled: boolean; bonus: number };
};
```

Language normalization should map ISO codes, provider labels and scene tokens
to canonical values. `ORIGINAL` is resolved from content metadata where
possible, not assumed to mean English.

Required language failures are hard eligibility failures, not small score
penalties. Preferred languages add score only after eligibility passes.

## 12. Hard requirements

Eligibility runs before scoring. Examples:

- required language mode `ALL` is not satisfied;
- wrong movie/series/season/episode identity;
- unsupported or unknown identity confidence below the configured threshold;
- profile resolution floor or explicit codec/container requirement fails;
- direct-play profile has a known incompatibility;
- a rule group explicitly rejects the version.

An ineligible version cannot win a profile because of a high technical score.
The profile can configure the consequence as `DELETE_CANDIDATE` or `REVIEW`,
but the engine must preserve the reason.

## 13. Scoring per profile

Each profile receives an independent score and breakdown:

```ts
type ProfileEvaluation = {
  profileId: string;
  eligible: boolean;
  score?: number;
  breakdown: Record<string, number>;
  reasons: Reason[];
};
```

`PRIMARY` can weight resolution, source, HDR, bit depth, codec and audio.
`REMOTE` can weight direct-play compatibility, codec/container/audio
compatibility, bitrate and size. Size is not a universal penalty: it is a
profile-specific objective.

Scores must be explainable and deterministic. A score is never sufficient by
itself to authorize deletion.

## 14. Rule Engine

Represent advanced rules as a validated recursive AST:

```ts
type RuleNode =
  | { op: 'AND' | 'OR'; children: RuleNode[] }
  | { op: 'NOT'; child: RuleNode }
  | { op: 'COMPARE'; field: string; operator: string; value: unknown }
  | { op: 'IN'; field: string; values: unknown[] }
  | { op: 'HAS'; field: string; value: unknown };
```

Initial fields: resolution, source, HDR, Dolby Vision, codec, bitrate, size,
audio codec, channels, audio language, subtitle language, release group and
profile eligibility.

The evaluator must whitelist fields/operators, cap nesting depth, reject
unknown fields, and return evaluation traces. The UI can begin with profile
forms and add the advanced tree editor after the AST/API is stable.

## 15. Direct Play strategy

V1 should not pretend to model every client. It should calculate a general
compatibility class from container, video codec, audio codec/channels,
subtitle format and known transcoding triggers:

```text
DIRECT_PLAY_LIKELY
DIRECT_PLAY_CONDITIONAL
TRANSCODE_LIKELY
UNKNOWN
```

Client-specific matrices for Plex/Jellyfin can be added later. Existing Plex
and Jellyfin integrations may validate or refresh libraries, but their APIs
should not become mandatory for the Version Manager engine.

## 16. Decision Engine

For every version group:

1. evaluate every enabled profile independently;
2. identify the best eligible version for each unsatisfied profile;
3. mark all profile winners `KEEP`;
4. mark a version `DELETE_CANDIDATE` only when it satisfies no unsatisfied
   profile and policy says the evidence is sufficient;
5. emit `REVIEW` for identity ambiguity, missing critical probe data, ties,
   conflicting profile outcomes or low confidence.

Example reason structure:

```ts
type Reason = {
  code: string;
  message: string;
  facts: Record<string, unknown>;
  severity: 'info' | 'warning' | 'error';
};
```

The final decision should include profile evaluations, competing versions,
confidence, rule trace and an immutable policy/config version.

## 17. Web UI

The existing Next.js dashboard is the correct integration point. Proposed
routes/pages:

- `/version-manager`: inventory overview and last scan;
- `/version-manager/profiles`: simple profile editor;
- `/version-manager/rules`: advanced nested rule builder;
- `/version-manager/review`: grouped KEEP/DELETE_CANDIDATE/REVIEW decisions;
- `/version-manager/history`: scans, policy versions, overrides and future
  delete audit.

Backend API proposal:

```text
GET  /api/version-manager/status
POST /api/version-manager/scan       # read-only inventory/probe scan
GET  /api/version-manager/groups
GET  /api/version-manager/groups/:id
GET  /api/version-manager/profiles
PUT  /api/version-manager/profiles
GET  /api/version-manager/review
POST /api/version-manager/review/:id # KEEP / IGNORE / REVIEW override only
GET  /api/version-manager/history
```

No delete route should exist in the first milestone. The existing generic
`/api/config` endpoint is not a sufficient replacement because profiles and
decisions need validation, auditability and concurrency control.

## 18. Review workflow

Review is a first-class queue, not an error log. Each group should show:

- content identity and confidence;
- each version's fingerprint and storage reference;
- profile eligibility and score breakdown;
- the selected winner per profile;
- redundant candidates and exact reasons;
- probe age/source and missing fields;
- operator actions `KEEP`, `IGNORE`, `REVIEW`.

The existing Organizer Review persistence/audit pattern is suitable as a
reference. Version decisions need separate tables because their lifecycle and
policy versioning differ from filename identity review.

## 19. Safety and future delete strategy

V1 is strictly dry-run. It may read provider APIs, inspect mounted files,
probe media and write SchröDrive's local inventory/decision database.

Future deletion must be a separate executor with:

- explicit dry-run/armed mode;
- per-item confirmation or an explicit bulk confirmation;
- provider and item re-fetch immediately before delete;
- content/hash/version identity revalidation;
- optimistic concurrency token or observed version;
- audit event before and after the provider call;
- idempotent result handling and no automatic retry on ambiguous delete;
- tombstone/history retention;
- no claim of rollback where the provider cannot restore a deleted magnet.

## 20. Test strategy

Unit tests:

- fingerprint normalization and missing-field behavior;
- language ANY/ALL/ORIGINAL policies;
- identity matching for movie, series, season, episode and multi-episode;
- rule AST validation/evaluation, including nested AND/OR/NOT;
- independent PrimaryScore/RemoteScore calculations;
- deterministic decisions and reason codes;
- dry-run guarantee that no provider delete method is called.

Integration tests:

- provider-neutral inventory adapter with AllDebrid fixture and another fake
  provider;
- SQLite persistence/restart recovery;
- probe cache invalidation and failed probe recovery;
- API/UI profile and review flows;
- race-safe future executor using a fake provider.

Real read-only validation:

- multiple 2160p versions;
- 2160p + 1080p pairs;
- ITA+ENG, ITA-only and ENG-only releases;
- HDR/DV variants;
- REMUX versus WEB-DL;
- TV episodes and season packs.

The current live inventory already contains useful non-destructive examples,
including 2160p ITA/ENG DV episodes, a 2160p HDR release, a 720p release and
multi-language releases. Actual decisions should be generated only after the
fingerprint/probe milestone exists; names alone must not be presented as
verified codec/audio facts.

## 21. Proposed architecture

Recommended option: **A/B — internal modular subsystem inside SchröDrive**.

```text
DebridProvider registry
        |
Inventory adapters (provider-neutral TorrentInfo/TorrentFile)
        |
Fingerprint pipeline (parser -> metadata -> optional ffprobe)
        |
Identity engine
        |
Version group repository (SQLite)
        |
Rule/eligibility engine -> profile scoring engine
        |
Decision + explanation repository (dry-run)
        |
Express API + Next.js Version Manager UI
```

Reasons against a separate service for V1:

- it would duplicate provider credentials and rate-limit handling;
- it would need another inventory synchronization boundary;
- it complicates SQLite/audit consistency;
- the existing backend already owns provider abstraction and mount context.

A future service split remains possible if probe workloads become expensive,
provided the contract is the normalized `MediaFingerprint` and not provider
objects.

## 22. REUSE / ADAPT / REIMPLEMENT / REFERENCE ONLY

| Source | Decision | Scope |
| --- | --- | --- |
| SchröDrive `DebridProvider`/registry | REUSE | Provider-neutral inventory boundary. |
| SchröDrive SQLite/config/API patterns | ADAPT | New version-manager tables and validated APIs. |
| SchröDrive `mediaParser` | ADAPT | Filename fallback and identity candidates. |
| SchröDrive Organizer Review | REFERENCE/ADAPT | Audit/review UX and persistence patterns. |
| DMM library/group/delete UI | REFERENCE ONLY | UX and provider behavior ideas; no code copy. |
| Zurg public config | REFERENCE ONLY | Declarative filters, ffprobe/cache/media-server concepts. |
| vibeDebrid filter engine | ADAPT concept, REIMPLEMENT code | Tiering and score breakdown; no source copy required. |
| ffprobe | REUSE external tool | Optional local probe; record version and output provenance. |

## 23. Risks

1. Filename metadata can lie or be incomplete; never mark deletion safe from
   filename-only evidence when critical fields are unknown.
2. TMDb/IMDb/TVDb matching can produce wrong identities for remakes, editions,
   specials and anime aliases; low confidence must become `REVIEW`.
3. Season packs and multi-episode files require an explicit scope model.
4. Provider APIs differ in hash/file identity and delete semantics.
5. Mounted WebDAV/rclone paths can be stale or unavailable; probe results need
   freshness and failure states.
6. Direct-play compatibility is client-dependent; V1 should expose a
   conservative general classification.
7. Deleting a Debrid magnet is usually irreversible; the executor must remain
   absent or disarmed until separately reviewed.
8. Large libraries require bounded concurrency, incremental scans and cache
   invalidation rather than probing every file on every page load.

## 24. Upstream PR strategy

Do not open the upstream PR yet. Split the eventual contribution:

1. normalized fingerprint and provider-neutral inventory contracts;
2. identity/version grouping and SQLite persistence;
3. profiles, language policies, hard requirements and scoring;
4. dry-run decisions, explanations and API;
5. Web UI profiles/review/history;
6. optional probe adapters and media-server compatibility;
7. future delete executor only after a separate safety review.

Every PR should be independently disabled/backward compatible, avoid provider
names in the core, add unit/integration tests, and document migration and
rollback. A CineCircle-specific configuration or path must not be part of any
upstream change.

## 25. Milestones

### M0 — assessment (this document)

Completed: code/repository analysis, license review, architecture decision,
read-only production inventory check, safety constraints and PR slicing.

### M1 — read-only inventory and fingerprint

Implement provider-neutral inventory records, filename parser projection,
optional ffprobe queue/cache, normalized `MediaFingerprint`, and SQLite
migrations. No decisions that authorize deletion.

### M2 — identity and version groups

Implement content identity confidence, TV scopes, multi-episode/season-pack
handling, and deterministic group persistence.

### M3 — profiles and decision engine

Implement PRIMARY and optional REMOTE defaults, configurable language policies,
hard requirements, nested rules, separate scores and explanations.

### M4 — read-only API and UI

Add Version Manager pages, review queue, history and profile editor. Validate on
real library data without provider mutation.

### M5 — controlled executor design

Only after M1–M4 results are reviewed: implement a disabled-by-default,
per-item-confirmed delete executor with revalidation and audit. This is not part
of the current milestone.

## 26. Current conclusion

No architectural or licensing blocker prevents an upstream-quality native
implementation. The correct next step is M1 on this dedicated branch. The
feature should remain disabled by default, start read-only, use the existing
provider abstraction, and treat missing/ambiguous metadata as `REVIEW` rather
than guessing.

## References

- [Debrid Media Manager](https://github.com/debridmediamanager/debrid-media-manager)
- [DMM AllDebrid API notes](https://github.com/debridmediamanager/debrid-media-manager/blob/main/alldebrid-api.txt)
- [DMM library management overview](https://github.com/debridmediamanager/debrid-media-manager/blob/main/src/pages/library.tsx)
- [Zurg public repository](https://github.com/debridmediamanager/zurg-public)
- [Zurg public configuration/wiki](https://github.com/debridmediamanager/zurg-public/wiki/Config)
- [vibeDebrid](https://github.com/vibeMonarch/vibeDebrid)
- [SchröDrive repository](https://github.com/moderniselife/SchroDrive)

## 27. M1 implementation and real-library verification — 2026-09-28

M1 is now implemented on `feature/debrid-version-manager-assessment`.

Implemented:

- `ffprobe` integration in `src/services/versionManagerProbe.ts`;
- runner image dependency (`ffmpeg`, which provides `ffprobe`);
- read-only probe states: `complete`, `unavailable`, and `error`;
- SQLite cache keyed by canonical mounted path and byte size. The cache does
  not use VFS mtime because the live AllDebrid mount refreshed mtime between
  identical reads;
- per-field provenance for identity, video, audio, subtitles, release and
  storage data;
- verified width/height, standard resolution bucket, codec, bitrate, bit depth,
  HDR10/HDR10+/Dolby Vision, container, audio codec/language/channels/bitrate,
  Atmos detection and subtitle language/forced status;
- optional Plex/Jellyfin metadata adapters and TMDb fallback. They use only
  read APIs and are not required by the core/provider abstraction;
- Version Manager preview API and UI now expose probe state, scores and
  explanations.

No delete executor, provider delete call, repair, dead scanner or production
restart was added.

### Real AllDebrid read-only scan

The inventory was collected from the active AllDebrid provider and the media
files were probed through the SchröDrive mount in an isolated probe container.
The SchröDrive production container was not restarted or replaced.

| Metric | Result |
|---|---:|
| Media records analysed | 303 |
| Files successfully probed | 296 |
| Probe unavailable | 7 |
| Probe errors | 0 |
| First-pass cache misses | 296 |
| Second-pass cache hits | 296 |
| Version groups | 286 |
| Groups with multiple versions | 16 |
| Identity-uncertain records/groups | 70 |
| Metadata-server matches | 0 in isolated run; no Plex/Jellyfin/TMDb credentials were supplied to the probe container |

With both `PRIMARY / QUALITY` and `REMOTE / DIRECT PLAY` enabled for this
read-only evaluation, the 303 records produced:

| Decision | Count |
|---|---:|
| KEEP | 230 |
| DELETE_CANDIDATE | 3 |
| REVIEW | 70 |

`DELETE_CANDIDATE` is only a dry-run label. No deletion is implemented or
possible through this milestone.

The reason distribution was: 432 profile-winner explanations, 3 no-profile-slot
explanations and 70 identity-uncertain reviews. A version can satisfy both
profiles, so profile-winner explanations can exceed the number of records.

### Representative multiversion groups

The following are real read-only results. Bitrates are bits/s; audio channels
are reported by ffprobe. `P` and `R` are the PRIMARY and REMOTE scores.

| Group | Verified versions and decision | Scores / explanation |
|---|---|---|
| Operazione Speciale Lioness | 2160p HEVC DV, 25.65 Mb/s, ITA/ENG EAC3 5.1, ENG Atmos → KEEP; second equivalent 24.93 Mb/s → DELETE_CANDIDATE | P70/R60; first wins both slots |
| Slow Horses | 2160p HEVC DV, 25.87 Mb/s → KEEP; 1080p HEVC, 6.10 Mb/s → KEEP | P67/R48 vs P55/R88; separate quality and remote winners |
| Love and Monsters (2020) | 2160p HEVC, 66.98 Mb/s DTS/FLAC → KEEP; 2160p HEVC, 17.99 Mb/s EAC3/AC3 → KEEP | P75/R30 vs P74/R50; each wins a profile |
| Mayday (2026) | 2160p HEVC DV, 26.67 Mb/s → DELETE_CANDIDATE; 1080p H264, 12.78 Mb/s Atmos → KEEP; 2160p HEVC, 25.30 Mb/s → KEEP | R101 for 1080p; primary retained separately |
| The Whisper Man (2026) | 2160p HEVC, 15.75 Mb/s → KEEP; 1080p HEVC, 2.88 Mb/s → KEEP | P61 vs R99; dual profile result |
| Finch (2021) | 2160p HEVC, 26.69 Mb/s → KEEP; 1080p H264, 15.45 Mb/s multilingual Atmos → KEEP | P61 vs R101; direct-play candidate retains languages |
| Reacher | 2160p HEVC DV, 15.14 Mb/s → KEEP; 1080p HEVC, 2.32 Mb/s AC3 2.0 → KEEP | P70 vs R69; separate winners |
| The Westies — group A | 1080p H264, 10.26 Mb/s → KEEP; 1080p HEVC, 6.47 Mb/s → KEEP | P52/R101 vs P58/R100; different profile winners |
| The Westies — group B | 1080p HEVC, 7.11 Mb/s → KEEP; 1080p H264, 10.10 Mb/s → KEEP | P58/R99 vs P52/R101; codec/bitrate trade-off exposed |
| The Westies — group C | 1080p HEVC, 6.65 Mb/s → KEEP; 1080p H264, 9.41 Mb/s → KEEP | P58/R100 vs P52/R102; both profiles remain satisfied |

The probe output included Matroska container, exact dimensions, audio stream
bitrate, subtitle count and provenance `FFPROBE`. Seven records could not be
resolved to a local mounted media path and therefore remain incomplete rather
than being treated as verified.

### M1 status and remaining gaps

M1 is functionally complete for read-only probing and cache validation. Identity
IDs and `original_language` are wired for Plex/Jellyfin/TMDb enrichment, but
the real run did not have usable metadata-server credentials in its isolated
environment, so the report must not claim those IDs were verified. Filename
identity remains the fallback and low-confidence records stay `REVIEW`.

Remaining work before any upstream proposal is stronger identity matching,
metadata-backed original-language validation, richer direct-play compatibility,
review/history UI and broader provider-backed tests. Deletion remains outside
scope.

## 28. Optional REMOTE policy and acquisition intent

The Version Manager now persists two independent policy switches:

```ts
{
  enableRemote: false,
  acquireMissingRemote: false
}
```

The default is deliberately single-slot PRIMARY behavior. When
`enableRemote=false`, the engine activates only quality profiles, does not
produce `REMOTE_MISSING`, and never retains a version merely as a possible
remote copy. When it is true, a `DIRECT_PLAY` profile is a separate slot and
has a hard verified `1080p` requirement. A 2160p version can never satisfy that
slot.

When PRIMARY exists but no eligible 1080p exists, the group reports
`REMOTE_MISSING` with `NO_ELIGIBLE_REMOTE_VERSION`. If and only if
`acquireMissingRemote=true`, identity confidence is sufficient and a TMDb,
IMDb or TVDb ID is available, the group also exposes an
`ACQUISITION_NEEDED` intent. This is an intent for future manual approval, not
an automatic request and not a delete decision.

The policy is persisted in `version_manager_policy`, exposed by the status API,
and configurable in `/version-manager`. The profile engine remains target-based
and can support additional slots in future; PRIMARY/REMOTE are not used as the
core data model.

## 29. Identity and metadata resolution milestone

The Version Manager identity pipeline keeps the filename parser as a
provider-agnostic fallback, then resolves metadata in this order:

1. provider IDs already present in the fingerprint;
2. Plex GUID/provider IDs, path and structured movie/series/season/episode
   identity;
3. Jellyfin `ProviderIds`, path and structured identity;
4. TMDb title/year lookup when configured;
5. the original filename/path identity with an explicit fallback status.

The normalized identity records `resolutionStatus` (`resolved`, `fallback`,
`uncertain`, `conflict`), per-field provenance, confidence, original language,
and provider-ID conflicts. Plex/Jellyfin/TMDb states remain distinguishable as
matched, not matched, ambiguous, unavailable, or configuration unavailable;
an empty result is not treated as proof that the library is empty.
Episodes retain series identity plus season/episode, so different episodes do
not enter the same Version Group. `original` language requirements compare
metadata `originalLanguage` with normalized audio language codes rather than
assuming English.

TMDb resolutions use the persistent `version_manager_metadata_cache` table,
with provider/query identity, metadata, timestamps, a one-day TTL, and explicit
invalidation. FFprobe remains independently cached in
`version_manager_probe_cache`. This milestone performs no provider, media file,
symlink, Organizer, repair, or delete operation.

Tests cover certain IDs, title/year fallback, homonyms, Plex GUIDs, Jellyfin
ProviderIds, conflicting IDs, series episodes and alternate versions,
unresolved identities, original-language policy, and metadata cache
hit/invalidation behavior. Live validation is read-only and uses an isolated
process with all mutating workers disabled.

## 30. Provider item/file-tree correction and conflict analysis

`fingerprintTorrent` now treats the provider item as a container rather than
as a media file:

```text
ProviderItem -> MediaFiles -> MediaFingerprint[]
```

The provider file tree is preferred. A provider item name is used as a
fallback only when it is itself a media filename. Sample media, artwork,
subtitles and unsupported files are excluded. A season/series pack therefore
produces one fingerprint per episode while remaining one provider item for
export and migration purposes.

On the real AllDebrid snapshot, the 105 previously excluded completed items
were fetched read-only from the AllDebrid file-tree endpoint:

| Metric | Result |
|---|---:|
| Provider items | 404 completed |
| File-tree items | 105 |
| All files in those trees | 581 |
| Media files discovered | 433 |
| Ignored sample files | 1 |
| Fingerprints | 731 |
| Provider items with fingerprints | 404 |
| Provider items without fingerprints | 0 |

The 105 recovered items classified as 34 movie folders/releases, 51 season
packs, 17 episode items, 2 other multi-media items and 1 single media file.

The pre-correction run produced 106 conflicts after the extra file-tree
records were included: 102 `TITLE_MISMATCH` and 6 `YEAR_MISMATCH`. Inspection
showed these were filename-versus-Plex disagreements on strong path/provider-ID
matches, including localized Plex titles and release suffixes. No
`PROVIDER_ID_MISMATCH`, `CROSS_PROVIDER_DISAGREEMENT`,
`MULTIPLE_PLEX_CANDIDATES` or real season/episode disagreement remained after
inspection. The resolver now ignores filename identity fields when an exact
provider-ID or path/basename match establishes the same media item, while it
continues to report disagreements between provider metadata candidates with
explicit reason codes. The corrected run produced 0 conflicts: 181 resolved
and 550 filename fallbacks.

The parser also accepts a parenthesized movie year followed by release tokens,
which removed a deterministic false parse in the real data. Different episodes
remain in distinct groups; same-episode alternate files converge into one
group.

## 31. Read-only Migration / Magnet Export

`src/services/migrationExporter.ts` implements a provider-neutral,
read-only `MigrationExporter` function. FULL_LIBRARY is inventory-driven and
does not require a fingerprint, identity, group or decision. Manifest records
retain the provider item as the export unit, with associated media files and
optional fingerprint/group enrichment. Multifile and season-pack items are
therefore exported once, not once per episode.

The versioned `manifest.json` model records provider item ID, safe original
name, status, completion, dates, media files, identity/provenance when
available, group/slot/decision enrichment, magnet/infohash and exportability
reason. `magnets.txt` contains one deduplicated magnet per infohash/magnet.
No raw provider object, credential, token or secret is copied to the export.

Supported modes are `FULL_LIBRARY`, `KEEP_ONLY`, `PRIMARY_ONLY`,
`REMOTE_ONLY`, `PRIMARY_REMOTE` and `SELECTED`. No importer or provider
mutation is implemented. The backend exporter and Web UI panel are complete
for this milestone.

The real AllDebrid status inventory exposed an infohash for all 404 completed
items. The read-only FULL export generated 404 manifest records and 404
deduplicated magnet lines. No import or mutation was attempted.

The corrected real scan produced 616 Version Groups and 80 multiversion groups.
With REMOTE disabled, the simulated decisions were 614 KEEP, 115
DELETE_CANDIDATE and 2 REVIEW. With REMOTE enabled, 658 PRIMARY assignments,
334 eligible 1080p REMOTE assignments and 288 `REMOTE_MISSING` groups were
reported; 102 acquisition intents were theoretical only. No 2160p version was
assigned to REMOTE. Plex supplied 211 catalog items and matched 181 records;
Jellyfin and TMDb were unavailable/configuration-unavailable in the isolated
process, so original-language coverage remained zero.

## 32. Shared TMDb service and current validation

The existing Organizer read `TMDB_API_KEY` from the shared core config and
implemented its own title/year search in `organizer.ts`. The lookup is now
shared through `src/services/tmdbService.ts`, which owns read-only movie/TV
search, deterministic candidate selection, external IDs, canonical title/year,
original language and explicit availability status. Organizer and Version
Manager use this service; there is no Version Manager-specific TMDb key.
Version Manager retains its SQLite cache around the shared client.

The active SchröDrive container and persisted configuration files available on
the server do not expose a `TMDB_API_KEY`; no secret was printed, copied or
committed. The real isolated validation therefore correctly reported TMDb as
`configuration_unavailable`, while Plex remained available read-only:

| Metric | Baseline | Current |
|---|---:|---:|
| Provider items / completed | 417 / 404 | 417 / 404 |
| Fingerprints | 731 | 731 |
| Version Groups / multiversion | 616 / 80 | 616 / 80 |
| Resolved / fallback | 181 / 550 | 181 / 550 |
| Conflicts | 0 | 0 |
| Plex catalog / matches | 211 / 181 | 211 / 181 |
| TMDb matches | 0 | 0 (`configuration_unavailable`) |
| Original language | 0 | 0 |
| REMOTE 1080p / missing | 334 / 288 | 334 / 288 |
| REMOTE 2160p | 0 | 0 |

TMDb cache activity was 0 hits / 0 misses because no configured key allowed no
lookup. Once the existing deployment configuration is made available to the
isolated process, the same pipeline will measure enrichment without changing
the API contract.

## 33. Generalization and upstream assessment

The core model and exporter are provider-neutral. AllDebrid-specific behavior
is confined to provider adapter/file-tree acquisition and inventory fields;
`TorrentInfo`, `MediaFile`, `MediaFingerprint`, groups, profiles and export
records do not require AllDebrid semantics. Plex, Jellyfin and TMDb are
metadata adapters with explicit availability states, not core prerequisites.

The remaining deployment presets are intentional configuration: the default
PRIMARY preset prefers 2160p quality and the optional REMOTE preset requires
verified 1080p. The engine evaluates enabled target-based profiles and tests
already cover custom profile IDs, so it does not require the names PRIMARY or
REMOTE. Seerr, CineCircle paths, Radarr/Sonarr and provider mutation are not
Version Manager core dependencies. Residual coupling is limited to the
backward-compatible default profile shape and the REMOTE-specific missing-state
policy, both documented as presets for this milestone.

## 34. Migration Export UI and security

`/version-manager` now contains an Export / Migration panel. It calls the
read-only `/api/version-manager/export` endpoint, previews provider-item,
exportable-item and unique-magnet counts, and downloads `magnets.txt` or
`manifest.json`. FULL_LIBRARY is inventory-driven and does not require
identity, fingerprinting or Decision Engine output.

The manifest is schema `1.0`, includes `generated_at`, `readOnly`, export mode
and provider item records. It contains no raw provider object, API key, token,
password, Plex/Jellyfin credential or TMDb key. Deduplication uses normalized
infohash/magnet identity; a season pack remains one provider item and one
magnet even when it produces multiple fingerprints. Import, add, delete,
repair and provider mutation remain unimplemented.

## 35. Golden real-data set

The real multiversion set contains 80 groups. Representative regression cases
include movie 2160p+1080p pairs, multiple 2160p releases (Love and Monsters,
Silo), three-way movie versions (Mayday), and multi-version episodes in season
packs (The Westies and Lucky). These are assessment examples only: no deletion
preference is asserted. The engine verifies grouping, explainable profile
eligibility and the hard rule that no 2160p version enters REMOTE.

## 36. TMDb configuration wiring diagnosis and real validation

The Settings UI persists `TMDB_API_KEY` through `POST /api/config` into the
`.env` selected by the running process. In the active container this is
`/app/.env`; `/api/config` reported the key as present with `source=file`.
Docker Compose also declares `TMDB_API_KEY`, but the active container received
an empty placeholder. `src/core/config.ts` previously read only
`process.env.TMDB_API_KEY`, so the persisted file value was ignored at module
initialisation. The isolated validation process consequently reported
`configuration_unavailable`, even though the UI and config API could see the
saved value.

The fix is limited to configuration loading: a non-empty runtime environment
value wins, otherwise the existing persisted `.env` value is used. There is no
`VERSION_MANAGER_TMDB_API_KEY`, no second credential store and no restart or
production change in this step. The active container's persisted value was
used only in memory for read-only validation; it was not printed, copied or
committed.

Smoke test: TMDb configured yes; request performed yes; response valid yes
(HTTP 200). The comparable validation used AllDebrid inventory plus its
read-only completed file trees, Plex GET requests and TMDb GET requests. All
Organizer/watch, repair, delete, reconciliation, mount and acquisition
workers were disabled; SQLite cache data was written only to a temporary
directory.

| Metric | Previous baseline | TMDb-enabled validation |
|---|---:|---:|
| Provider items / completed | 417 / 404 | 417 / 404 |
| Fingerprints | 731 | 735 |
| Version Groups / multiversion | 616 / 80 | 609 / 89 |
| Identity resolved / fallback | 181 / 550 | 602 / 88 |
| Identity uncertain / conflicts | not separated / 0 | 45 / 0 |
| Plex catalog / pipeline matches | 211 / 181 | 211 / 182 |
| TMDb matched | 0 | 420 |
| TMDb resolution attempts | 0 | 553 |
| TMDb HTTP requests / cache hits | 0 / 0 | 175 / 377 |
| TMDb not matched / ambiguous | 0 | 87 / 45 |
| TMDb unavailable / configuration unavailable | 0 / 0 | 0 / 1 |
| TMDb ID / IMDb ID / TVDb ID | not measured | 584 / 584 / 574 |
| Original language known / unknown | 0 / 731 | 420 / 315 |
| REMOTE 1080p / REMOTE_MISSING | 334 / 288 | 333 / 280 |
| REMOTE 2160p | 0 | 0 |
| FULL manifest / unique magnets | 417 / 417 | 417 / 417 |

The one `configuration_unavailable` counter is a legacy status for a record
without a usable title; it was not a failed credential or network lookup.
TMDb HTTP failures were zero. The 735-vs-731 fingerprint delta reflects the
current live file-tree response and inventory state, not an identity algorithm
change. Probe remained unavailable for all 735 records because the isolated
runner had no local media path; no media was downloaded or mounted.

Metadata resolution is Plex-first. The run therefore produced 182 Plex
matches and 420 TMDb fallback matches; it does not perform a second TMDb
lookup for a strong Plex match, so a direct Plex+TMDb concordance matrix is not
claimed. No cross-provider disagreement was observed. `original_language` is
now populated from TMDb independently of audio tracks: the dataset contained
416 English (`en`), 3 Hebrew (`he`) and 1 Korean (`ko`) originals. No
Italian-original title was present, so no Italian example is invented. Real
examples were `Lanterns` (`en`) and `Tehran` (`he`). Existing rule tests verify
that `ORIGINAL` uses this metadata value and is not implicitly treated as
English.

With the current remote simulation, 333 1080p versions satisfied REMOTE, 280
groups were `REMOTE_MISSING`, and no 2160p version entered REMOTE. Acquisition
remained disabled by policy, so no Seerr request was generated. FULL export
remained inventory-driven: 417 manifest records and 417 deduplicated magnet
lines, including identity-independent provider items.

## 37. Media Server Independence

### Dependency assessment

Plex and Jellyfin are not structural dependencies of the Version Manager.
`enrichVersionMetadata()` loads them as optional catalogs. Their contributions
are limited to candidate matching by external ID, path or structured title /
season / episode metadata, plus enrichment and confidence evidence. The
Version Group key and profile engine consume the normalized fingerprint
identity and verified media attributes; they do not call Plex or Jellyfin.

The filename/path parser and TMDb service remain usable when both catalogs are
unavailable. With neither media server nor TMDb, the pipeline degrades to
filename/path identity, `fallback`/`uncertain` status and `REVIEW` rather than
crashing. A regression test now covers this no-catalog path.

The assessment found one deterministic parser coupling that Plex had been
masking: the parenthesized movie-year rule ran before the season/episode rule.
`The Westies (2026) - S01E01 ...` was therefore initially classified as a
movie without Plex path mapping. The safe fix gives season/episode notation
precedence and adds a regression test. No confidence threshold or fuzzy
matching rule was changed.

### Live comparison

The requested historical baseline is retained below. Because the live
AllDebrid file tree now exposed 735 fingerprints rather than 731, a paired
post-fix control was also run against the same inventory for an apples-to-apples
comparison.

| Metric | Historical Plex + TMDb | Paired Plex + TMDb | Paired TMDb-only | Delta TMDb-only |
|---|---:|---:|---:|---:|
| Provider items / completed | 417 / 404 | 417 / 404 | 417 / 404 | 0 / 0 |
| Fingerprints | 731 | 735 | 735 | 0 |
| Version Groups | 616 | 618 | 615 | -3 |
| Multiversion groups | 80 | 90 | 92 | +2 |
| Resolved | 602 | 620 | 576 | -44 |
| Fallback | 88 | 70 | 103 | +33 |
| Uncertain | 45 | 45 | 56 | +11 |
| Conflict | 0 | 0 | 0 | 0 |
| Original language known | 420 | 438 | 576 | +138 |
| TMDb matched | 420 | 438 | 576 | +138 |
| REMOTE 1080p | 334 | 338 | 336 | -2 |
| REMOTE_MISSING | 288 | 280 | 278 | -2 |
| REMOTE 2160p | 0 | 0 | 0 | 0 |
| FULL export items / unique magnets | 417 / 417 | 417 / 417 | 417 / 417 | 0 / 0 |

Paired Plex control statistics were 553 identity-resolution attempts, 158
TMDb HTTP requests, 394 cache hits, 438 TMDb matches and zero network errors.
TMDb-only statistics were 735 attempts, 322 HTTP requests, 412 cache hits, 576
matches, 102 not-matched results, 56 ambiguous results, zero network errors
and one legacy `configuration_unavailable` status caused by a record without a
usable title. The key was available in both runs and no credential was logged.

Plex supplied 211 catalog entries. The paired run had 182 Plex matches and 438
TMDb fallback matches; the TMDb-only run recovered 576 matches without Plex.
The implementation is Plex-first, so direct Plex+TMDb concordance is not
claimed for the same item: TMDb is intentionally skipped after a strong Plex
match. No new conflict or cross-provider disagreement appeared.

TMDb-only ID coverage was TMDb 576, IMDb 557 and TVDb 429. Original-language
coverage was 576: English 566, Hebrew 3, Korean 2, Portuguese, Chinese,
Spanish, Italian and another Chinese/variant code represented the remaining
records. Real examples included `Toy Story 5` (`en`), `Diabolik` (`it`) and
`Tehran` (`he`). `ORIGINAL` therefore remains metadata-driven and is not an
implicit English alias.

### Golden dataset comparison

The post-fix golden checks showed the following stable behavior in both modes:

- `The Westies` season-pack files now resolve as episode `S01E01`, `S01E02`,
  etc., with TMDb series ID `286709`; versions of the same episode converge.
- `Love and Monsters`, `Mayday` and `Finch` retain their TMDb movie identity,
  multiversion grouping and PRIMARY decisions without Plex.
- `Reacher` episode versions retain series ID `108978`, season/episode
  separation and the same PRIMARY/REMOTE eligibility.
- `Lucky` episode versions retain series ID `278624` and the same episode
  grouping.
- `Silo` episodes without a year remain `uncertain` in TMDb-only mode when
  TMDb returns an ambiguous/no reliable candidate; Plex can enrich these via
  library mapping. This is a bounded metadata-quality gap, not a crash or a
  structural Plex requirement.

The paired post-fix profile result was 338 REMOTE 1080p and 280 missing; the
TMDb-only result was 336 REMOTE 1080p and 278 missing. Both modes produced zero
REMOTE 2160p assignments. The two-count differences follow the changed
identity eligibility, not a change to REMOTE semantics.

### Final architecture and upstream implication

Required core inputs are `DebridProvider`, provider item/file discovery and
filename/path parsing. TMDb is the preferred canonical metadata provider when
configured. Plex and Jellyfin are optional MetadataProvider adapters that can
improve identity, path mapping, external-ID evidence and lookup efficiency;
they do not enable the Version Manager. The only code change in this step was
the deterministic parser precedence fix. AcquisitionAdapter, Seerr, import,
Delete Executor and provider mutation remain out of scope.
