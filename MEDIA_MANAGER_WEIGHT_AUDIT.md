# Media Manager Weight Audit

## Baseline

- Upstream baseline: `f6f20d52cddca44529e225128095a13c97c0e428`
- Integration branch: `integration/media-manager-develop-alignment`
- Integration HEAD: `cd403fd`
- Develop alignment: no merge was required; the original Media Manager
  branch was already based on the fetched upstream/develop. The shared
  mount-readiness PR #106 was integrated for validation as a separate commit.

## Size

Compared with upstream/develop, including the integration FUSE change:

- Files changed: 139
- Production/source additions: 4,605; removals: 112
- Test additions: 2,342; removals: 2
- Documentation additions: 3,049
- Generated `dist` additions/changes: 4,599; removals: 178
- Web additions: 2,002; removals: 77
- Total: 16,900 additions, 379 removals
- New runtime dependencies: none
- New database tables/migrations: none added by the integration alignment
- New background workers/timers: none identified in the Media Manager delta

The generated `dist` files and assessment/tracking documents are extraction
concerns, not evidence that the upstream Media Manager PR should contain them.

## Hotspots

- `web/src/components/media-manager/media-manager-shell.tsx` — 1,650 LOC;
  combines page orchestration, data loading, filters and action presentation.
- `src/server.ts` — 1,599 LOC; route registration and service wiring remain
  concentrated here.
- `src/services/mount.ts` — 1,631 LOC; provider/mount and filesystem concerns
  are broad, although the readiness guard itself is covered by focused tests.
- `src/services/versionManager.ts` — 626 LOC in the integrated source;
  policy, inventory-facing orchestration and decision boundaries are coupled.
- `src/services/organizer.ts` — 1,126 LOC; existing Organizer behavior plus
  generic safety/readiness integration.

No dependency cycle, duplicate Policy Engine, duplicate recoverability engine,
or second identity resolver was found during this pass. A full dependency graph
tool was not added solely for this audit.

## Dead / Legacy Candidates

- Generated `dist` changes: retain for the current repository build contract,
  but exclude from future upstream PR extraction unless the project requires
  committed build output.
- Runtime assessment, snapshot and deployment-tracking documents: exclude from
  upstream PR extraction; they are project history, not product code.
- No source helper or public export was removed: no candidate met the
  unequivocal-unused and no-public-contract-risk threshold.

## Abstraction Assessment

- Provider capability/file-tree boundary: **JUSTIFIED**; used by inventory and
  migration and required for more than one provider.
- Migration exporter/importer and recoverability model: **JUSTIFIED**; shared
  by preview, restore planning and provider capabilities.
- Identity evidence/provenance and manual override: **JUSTIFIED**; preserves
  automatic evidence and supports canonical manual identity.
- Unified review read model: **JUSTIFIED**; aggregates Organizer, Policy and
  Recoverability without creating a new source of truth.
- Per-source mount readiness: **JUSTIFIED**; prevents NOT READY from becoming
  EMPTY while allowing independent ready sources to continue.
- Media Manager web shell and server route concentration: **QUESTIONABLE** for
  future decomposition, but not safe to refactor during alignment.
- Legacy reports/generated output in an upstream extraction: **REMOVE_FROM_
  UPSTREAM_EXTRACTION_ONLY**, not a runtime cleanup in this branch.

## Runtime / Build Impact

- Post-alignment suite: 251 passed, 0 failed, 630 assertions, 39 files.
- Typecheck: passed.
- Backend build: passed.
- Web build: passed; Media Manager routes generated successfully.
- Read-only runtime smoke testing found the unified Review backend route was
  present but its Next proxy was missing; the minimal proxy was added and the
  Web build now includes `/api/version-manager/review`.
- No production runtime was switched and no provider API mutation was issued
  by this audit.
- No representative real-provider latency benchmark was run; doing so would
  add noise and is unnecessary for this read-only alignment audit.
- Browser smoke was executed with Playwright/Chromium against the active
  runtime: all 12 requested pages returned successful HTML, while the active
  image still returned 404 for the not-yet-deployed Review proxy and 503 for
  provider-backed Migration State.
- The integration image was then built and run in isolation with all
  provider/mount/poller/mutation paths disabled. Review returned HTTP 200 with
  the expected unified schema; browser navigation passed. Migration State
  returned HTTP 503 with the explicit configuration error expected from an
  unconfigured isolated provider set.
- A second isolated run with a deterministic provider fixture populated
  Content Detail and returned Migration State HTTP 200 (`ALREADY_PRESENT`);
  Playwright verified both interactions with no unexpected network failures.

## Recommended Cleanup

### SAFE_NOW

- None. The remaining candidates either affect extraction boundaries,
  generated artifacts, or broad service/UI responsibilities.

### OPTIONAL_LATER

- Split the Media Manager shell into data, queue and editor components.
- Split server route registration from business orchestration.
- Add a lightweight dependency/cycle report using existing tooling if needed.

### DO_NOT_TOUCH_BEFORE_UPSTREAM

- Inventory, identity precedence, policy/hash, recoverability, migration and
  provider capability contracts.
- Organizer behavior beyond independently reviewed generic upstream fixes.

### REMOVE_FROM_UPSTREAM_EXTRACTION_ONLY

- Runtime reports, local deployment tracking, validation-runtime references,
  generated output where upstream does not commit it, and operational snapshots.
