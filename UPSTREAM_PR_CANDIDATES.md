# Upstream PR Candidates

Internal tracking document for generic SchröDrive fixes that may be proposed
as small, independently reviewable upstream changes. This document is not a
PR and contains no credentials or provider secrets.

Comparison baseline: `upstream/develop` fetched on 2026-09-28 at
`f6f20d52cddca44529e225128095a13c97c0e428`. Historical commits are recorded
without rewriting the branch history.

## 1. Arr bridge — preserve nested staging paths

### Classification

`ALREADY_FIXED_UPSTREAM`

### PR dependency

`STANDALONE`

### Component

Arr bridge

### Problem

Recursive media discovery returned only a basename. Files with the same name
under different nested directories could therefore lose their relative
layout when exposed to Radarr/Sonarr.

### Root cause

`scanDirRecursive` did not carry the root directory through recursion and the
symlink destination did not create the nested parent directory.

### Previous behavior

Nested files were flattened and could collide or be exposed at the wrong
path.

### Expected behavior

Preserve the path relative to the torrent/content root and create only the
required destination subdirectory.

### Fix

Commit `a20b84fa5aeff21afaba1b06cafcf790b162de64` exports the recursive
scanner with a `rootDir`, returns relative names, and creates the destination
parent before linking.

### Files changed

`src/services/arrBridge.ts`,
`tests/e2e/arr-bridge/qbittorrent-api.test.ts`.

### Tests

Regression test for two equal-named files in different nested directories.

### Upstream applicability

Generic and already present in the fetched upstream `develop` history. No new
PR candidate is required on this branch.

### Isolation

Already isolated in its original commit.

### Proposed PR scope

None; retain as historical reference.

## 2. Arr bridge — restart recovery

### Classification

`ALREADY_FIXED_UPSTREAM`

### PR dependency

`STANDALONE`

### Component

Arr bridge / SQLite state

### Problem

Tracked torrents held only in memory disappeared after an Arr bridge restart.

### Root cause

No durable state table or startup restore path existed for tracked torrents.

### Fix

Commit `1c6f49479488014cd2989eb9cd9d765aae24236e` adds SQLite persistence,
startup restoration, state updates, deletion cleanup, and restart tests.

### Files changed

`src/core/db.ts`, `src/services/arrBridge.ts`,
`tests/e2e/arr-bridge/restart-recovery.test.ts`.

### Tests

Restore after restart and do-not-restore-after-qBittorrent-delete tests.

### Upstream applicability

Generic and already present in fetched upstream `develop`.

### Isolation

Standalone historical fix.

### Proposed PR scope

None; retain as historical reference.

## 3. Organizer — preserve colliding media versions

### Classification

`GENERIC_UPSTREAM_FIX`

### PR dependency

`STANDALONE` (future upstream extraction required)

### Component

Organizer / symlink safety

### Problem

Two releases could resolve to the same canonical destination. The old path
could unlink a valid symlink pointing to release A before linking release B.

### Root cause

Destination collision handling treated an existing symlink to another source
as replaceable.

### Previous behavior

Discovery order could silently remove one valid version and make the result
non-idempotent.

### Expected behavior

Preserve the existing link and allocate a deterministic, filesystem-safe
alternate destination derived from the incoming source path. Repeated scans
and reversed discovery order must not lose either version.

### Fix

Commit `e7cf2de4a6f99e23b2379ccea892557ff075d0a6` adds deterministic
collision resolution, preserves existing symlinks, sorts discovery input, and
protects real files/directories.

### Files changed

Primarily `src/services/organizer.ts` and
`tests/unit/services/organizer-safety.test.ts`; the commit also contains
configuration/assessment changes, so it is not a clean upstream cherry-pick
as-is.

### Tests

Collision preservation, deterministic suffix, idempotence, real-file safety,
and multiversion organizer tests.

### Upstream applicability

Generic; absent from fetched upstream `develop`. It does not depend on the
Version Manager or its decisions.

### Isolation

Requires extracting the organizer-only diff from `e7cf2de` before proposing a
PR. Do not rewrite this branch history.

### Proposed PR scope

Organizer collision-safe destination allocation plus focused regression tests;
no profile/KEEP/DELETE logic.

## 4. Organizer — optional category directories

### Classification

`GENERIC_UPSTREAM_FIX`

### PR dependency

`STANDALONE` (future upstream extraction required)

### Component

Organizer / filesystem safety precheck

### Problem

A missing unused category directory, such as `Anime`, was treated as if the
entire organized library were unavailable and aborted the scan.

### Root cause

The precheck conflated the required organized root with optional destination
categories and attempted pruning checks against every category.

### Expected behavior

The organized root remains fail-closed. Category directories are optional,
created lazily only when an item needs them, and never created in dry-run.

### Fix

Commit `a19892cf71ef21ab1773fca1502cce5a5503a077` validates the root,
tolerates absent categories, creates needed destinations lazily, and reports
would-create in dry-run.

### Files changed

`src/services/organizer.ts`,
`tests/unit/services/organizer-safety.test.ts`.

### Tests

Missing root/inaccessible root fail closed; unused category remains absent;
needed category is created only in normal mode; dry-run remains non-mutative.

### Upstream applicability

Generic and independent of CineCircle and Version Manager. Absent from the
fetched upstream `develop`.

### Isolation

Requires extracting the organizer-only commit because the current branch has
subsequent local work around the same organizer safety area.

### Proposed PR scope

Required-root versus lazy-category semantics with focused tests.

## 5. Organizer filename mode

### Classification

`NEEDS_UPSTREAM_VERIFICATION`

### PR dependency

`DEPENDS_ON: organizer collision-safe destination extraction`

### Component

Organizer / configuration / Web UI

### Problem

The validation-runtime supported `ORGANIZER_FILENAME_MODE=original`, while
the standard path had regressed to canonical-only naming.

### Root cause

Filename mode was not consistently propagated through the standard target
calculation path.

### Fix

The mode is represented in `src/core/config.ts` and `src/core/configApi.ts`,
and selected by `src/services/organizer.ts`; tests cover canonical and
original modes. The relevant changes are mixed into `e7cf2de` and earlier
commit `36d57a1`.

### Tests

`tests/unit/services/organizer-safety.test.ts` and historical organizer
filename tests.

### Upstream applicability

Potentially generic, but upstream intent/availability of this option must be
verified before calling it a regression or proposing a PR.

### Isolation

Not currently isolated cleanly; do not combine it automatically with the
collision PR.

### Proposed PR scope

Only if upstream confirms the option is supported or intentionally required:
configuration, target selection, and focused tests.

## 6. Persisted `.env` configuration fallback

### Classification

`NEEDS_UPSTREAM_VERIFICATION`

### PR dependency

`STANDALONE`

### Component

Config / runtime

### Problem

Docker may provide an empty environment placeholder while Settings persists a
real value in `/app/.env`; direct `process.env` reads then incorrectly report
the setting as unavailable.

### Root cause

Runtime configuration did not distinguish an empty injected value from a
usable value in the persistent env file.

### Fix

Commit `e7983ad45468a5fad6d1bb45f75b6f13732710a` introduced the shared
runtime-or-persisted resolver and applied it to persisted TMDb/metadata
configuration. The current config API also preserves existing file content.

### Tests

Runtime value precedence and empty-runtime-placeholder fallback tests in
`tests/unit/core/configApi.test.ts`.

### Upstream applicability

The resolver is generic, but the exact Docker/config deployment behavior must
be compared with upstream before proposing it. The commit also contains
Version Manager metadata changes, so extraction is required.

### Isolation

Potentially standalone after extracting only config core and tests.

### Proposed PR scope

Generic persistent-config fallback semantics, with no Version Manager code.

## 7. Seerr Settings persistence key mismatch

### Classification

`GENERIC_UPSTREAM_FIX`

### PR dependency

`STANDALONE`

### Component

Settings Web UI / config API

### Problem

The Settings UI sent `OVERSEERR_URL`, `OVERSEERR_API_KEY`, and
`OVERSEERR_AUTH`, while the schema, persistence layer, and runtime client use
the canonical `SEERR_URL`, `SEERR_API_KEY`, and `SEERR_AUTH` keys. Save
appeared successful, but reload returned empty/default values.

### Root cause

The UI referenced legacy aliases that were not keys in `CONFIG_SCHEMA`.

### Expected behavior

The UI must submit the canonical schema keys and preserve existing secrets
when saving unrelated fields.

### Fix

Commit `2e6e4c9bade876a04472a21690031a7608075ebc` changes only the UI field
bindings to `SEERR_*`; legacy aliases remain supported by runtime resolution
for backward compatibility, without adding a second persistent namespace.

### Files changed

`web/src/app/(dashboard)/settings/page.tsx`,
`tests/unit/core/configApi.test.ts`.

### Tests

Regression test covers canonical save, persisted reload, absence of legacy
key emission, and preservation of an existing API secret during a partial
save. Full relevant suite: 163 pass, 0 fail.

### Upstream applicability

Generic SchröDrive Settings bug, independent of CineCircle and Version
Manager. It is absent from fetched upstream `develop`.

### Isolation

Clean standalone commit, already pushed on this branch; no history rewrite is
needed.

### Proposed PR scope

Canonical Seerr Settings field names plus the focused persistence regression
test.

## Secret preservation assessment

The current `saveConfigToFile` updates only keys present in the submitted
partial update and leaves other `.env` lines untouched. The new regression
test verifies that an existing Seerr secret survives saving another field.
No separate generic secret-loss bug was reproduced in this assessment. The
UI/API still need a future security review of how secret values are represented
in GET responses; that is not folded into the Seerr key fix here.

## Candidate summary

| Candidate | Classification | Commit | Standalone | Tests | Upstream status | Priority |
|-----------|----------------|--------|------------|-------|-----------------|----------|
| Arr nested staging paths | ALREADY_FIXED_UPSTREAM | `a20b84f` | yes | regression present | present in upstream develop | low |
| Arr restart recovery | ALREADY_FIXED_UPSTREAM | `1c6f494` | yes | regression present | present in upstream develop | low |
| Organizer collision safety | GENERIC_UPSTREAM_FIX | `e7cf2de` | extract | organizer safety | absent from fetched upstream develop | HIGH |
| Optional category directories | GENERIC_UPSTREAM_FIX | `a19892c` | extract | organizer safety | absent from fetched upstream develop | HIGH |
| Organizer filename mode | NEEDS_UPSTREAM_VERIFICATION | `36d57a1` / `e7cf2de` | no | filename/safety | intent not yet verified | medium |
| Persisted `.env` fallback | NEEDS_UPSTREAM_VERIFICATION | `e7983ad` | extract | config unit tests | absent; applicability needs review | medium |
| Seerr canonical Settings keys | GENERIC_UPSTREAM_FIX | `2e6e4c9` | yes | config persistence | absent from fetched upstream develop | HIGH |

No PR, upstream branch, existing PR, or commit history was modified by this
tracking update.
