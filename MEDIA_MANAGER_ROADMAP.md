# Media Manager Roadmap

## CURRENT STATUS

- Develop alignment: `VALIDATED` against
  `f6f20d52cddca44529e225128095a13c97c0e428`.
- Weight audit: `VALIDATED`; no SAFE_NOW code cleanup identified.
- Full E2E acceptance: `PARTIAL`; the isolated integration image passes the
  Review API/browser path, while Migration State returns the expected
  configuration 503 without a provider and the empty isolated DATA_DIR cannot
  exercise populated Content Detail actions.
- Media Manager upstream readiness: `NEEDS_FIXES` before PR splitting.

The frozen Media Manager branch remains preserved separately. The integration
branch includes the generic per-source mount-readiness change for validation;
upstream PR #106 remains OPEN and is not assumed merged.

## OPEN ITEMS

- If required for release acceptance, run the isolated image with a sanitized
  provider-backed fixture/configuration to cover populated Content Detail and
  migration state; do not change the active production container.
- Reassess extraction boundaries for generated `dist` and local assessment
  documents.
- Do not begin Media Manager PR splitting in this milestone.

## HISTORY

- 2026-09-29 — Created protected integration branch from the frozen Media
  Manager state; upstream/develop was already the merge base.
- 2026-09-29 — Integrated the shared per-source mount-readiness guard from the
  still-open upstream PR #106 for validation; tests remained green.
- 2026-09-29 — Completed the first weight audit; no behavior-preserving
  SAFE_NOW cleanup was justified.
- 2026-09-29 — Added the missing read-only Web proxy for the unified Review
  endpoint; backend and Web route contracts now align in the source build.
- 2026-09-30 — Chromium browser smoke visited all Media Manager and Migration
  pages; the active image exposed the pre-fix Review 404 and provider-backed
  Migration State 503, without any mutation.
- 2026-09-30 — Built and ran the integration image in an isolated container;
  Review API/schema and browser routes passed, while Migration State correctly
  reported `Source provider is not configured`.

## POST_MVP_UPGRADE — MEDIA_MANAGER_SIMPLE_POLICY_PRESETS

Add a user-friendly Simple mode with presets such as Maximum Quality, Quality
+ Direct Play, Space Efficient, Italian Required, Italian Preferred,
Multilanguage, and Conservative Cleanup.

Simple mode must generate and edit the same canonical policy model used by the
Advanced / Custom Rules editor:

- `VersionProfile[]`
- hard requirements
- scoring rules
- language policy
- safety policy

If a preset is subsequently edited in Advanced mode, expose a semantic state
such as `Maximum Quality — Customized` without discarding the edits or treating
the result as identical to the original preset.

This is a post-MVP upgrade. It is intentionally not implemented in the current
Policy Editor milestone and does not introduce a second policy engine.

## Runtime validation baselines

### Legacy incomplete inventory

The historical baseline `520 / 357 / 11 / 152` is retained only as historical
evidence. It is classified as `LEGACY_INCOMPLETE_INVENTORY` and is not a target
for current validation.

### Current canonical full-file-tree inventory

- Versions: 736
- VersionGroups: 632
- KEEP: 629
- DELETE_CANDIDATE: 70
- REVIEW: 37
- PRIMARY missing: 3
- REMOTE missing: 0

The current canonical decision-config hash is `298a80b293d19046`. The previous
hash `395cfa66603dc264` remains historical evidence from the policy-only hash
implementation; the active policy was not changed when the hash inputs were
expanded.

## Follow-up tracking

### TECHNICAL_DUPLICATE_REPRESENTATIONS

- 2 groups;
- 2 excess Versions;
- no DELETE_CANDIDATE involved;
- non-blocking;
- not implemented in the current milestone.

### FUSE/MOUNT PRECHECK

- classification: `DEPLOYMENT_ONLY`;
- candidate for fork generalization;
- possible `GENERIC_UPSTREAM_FIX`;
- not implemented in the current milestone.

### SIMPLE POLICY PRESETS

- classification: `POST_MVP_UPGRADE`;
- Advanced / Custom Rules remains the canonical policy editor;
- future Simple Mode must use the same policy model;
- language presets must remain generic and not hardcode Italian.
