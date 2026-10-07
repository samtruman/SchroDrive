# Core PR Recovery Plan

Status: draft, not committed
Scope: core SchröDrive changes only. Media Manager UI and Media Manager policy work are intentionally excluded.

## Objective

Recover the core changes currently present in the integration branch into independent pull requests based on `upstream/develop`, preserving the existing behavior and avoiding a single oversized PR.

## PR 1 — Provider reconciliation and AllDebrid polling

Purpose:

- opt-in provider reconciliation worker;
- generic provider reconciliation contract;
- recent and full provider scans;
- detection of added, changed, and removed provider items;
- routing completed media to Radarr/Sonarr;
- serialized scans and known-item diff coverage;
- current polling fix that includes older provider items already known locally.

Primary historical commits:

- `07ce297` — wire opt-in AllDebrid reconciliation worker;
- `d5d08d5` — isolate Arr test mount paths;
- `1d1d136` — pass AllDebrid credentials to isolated runtime;
- `56cb68a` — use ready mount paths and copy imports;
- `e4bf994` — expose AllDebrid media through symlink rescans;
- `6d3d259` — generalize provider reconciliation.

Additional changes to extract:

- current uncommitted changes in `src/services/providerReconciliation.ts`;
- matching regression tests;
- the deployed entrypoint change adding `--env-file=/config/.env`, which must be represented in the repository/deployment configuration before opening the PR.

## PR 2 — Media-server metadata and Jellyfin identity

Purpose:

- generalize media-server metadata providers;
- use Jellyfin MediaBrowser authorization;
- preserve TMDB/TVDB/provider identity evidence.

Primary commits:

- `3067092` — generalize media server metadata providers;
- `c70e540` — use MediaBrowser authorization.

## PR 3 — Organizer multiversion safety

Purpose:

- preserve multiple versions and symlinks safely;
- avoid collisions during organization;
- treat categories as lazy destinations;
- preserve original release filenames where configured.

Primary commits:

- `e7cf2de` — preserve multiversion symlinks safely;
- `a19892c` — treat categories as lazy destinations.

Related existing branches should be reused where possible instead of duplicating work.

## PR 4 — Migration export and import core

Split this into two PRs if the dependency graph remains clean.

Export/preview:

- version-manager file-tree export;
- migration preview;
- manifest and magnet deduplication;
- provider capability assessment.

Import/restore:

- guarded single-item restore;
- resumable bulk import;
- legal rejection classification;
- provider rate-limit retry;
- audit preservation;
- Real-Debrid file-tree handling.

Primary commits:

- `ebe6db8`;
- `c9be39c`;
- `43af9b9`;
- `8c7cfe1`;
- `354f635`;
- `01d0fd3`;
- `e1876b0`;
- `78380e8`;
- `c38b75d`;
- `3cf5ad2`.

## PR 5 — Acquisition and Seerr core

Purpose:

- read-only acquisition preview;
- ARR profile discovery;
- guarded single Seerr requests;
- duplicate-request detection and audit.

Primary commits:

- `b3b7a0c`;
- `3188dab`;
- `c3e6ca5`;
- `9770713`;
- `05a6656`.

## PR 6 — Configuration and provider settings core

Purpose:

- persisted TMDB configuration;
- runtime versus persisted dotenv provenance;
- persistence on the mounted config volume;
- canonical provider credential keys with legacy read compatibility.

Primary commits:

- `e7983ad`;
- `8e8566a`;
- `6854f4d`;
- `ca6c12a`.

Existing provider-settings branches should be compared before creating another PR.

## Extraction rules

1. Start every PR from `upstream/develop`.
2. Cherry-pick only the commits belonging to that PR.
3. Extract core hunks from the current uncommitted diff manually; do not cherry-pick or commit the Media Manager hunks.
4. Preserve existing tests with each feature.
5. Run targeted tests, typecheck, and the full suite for every PR.
6. Do not include:
   - Media Manager UI;
   - Media Manager delete/review policy changes;
   - `RELEASE_QUALIFICATION_REPORT.md`;
   - `test-results/`.
7. Do not push or open PRs until the branch contents have been reviewed.

## Current repository state

The current integration worktree still contains uncommitted changes in:

- `src/services/providerReconciliation.ts`;
- `src/server.ts`;
- `src/services/versionManager.ts`;
- `src/services/unifiedReview.ts`;
- matching tests;
- `web/src/components/media-manager/media-manager-shell.tsx`.

Only the provider reconciliation changes belong to the first core PR. The remaining files contain mixed or Media Manager work and must be split carefully.

## Recommended order

1. Provider reconciliation and polling.
2. Media-server metadata/Jellyfin.
3. Organizer safety.
4. Migration export/import.
5. Acquisition/Seerr.
6. Configuration/settings.

No commit or pull request has been created by this document.
