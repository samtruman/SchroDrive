# Media Manager Roadmap

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
