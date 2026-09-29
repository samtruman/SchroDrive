# Media Manager — Canonical Inventory Assessment

## Physical inventory

- ProviderItems: 418
- File-tree items: 405
- File-tree media observations: 889
- Fingerprints: 736
- Unique physical/logical keys: 734
- Technical duplicate groups: 2
- Duplicate excess: 2
- ContentIdentity keys: 632
- VersionGroups: 632
- Versions: 736

The technical comparison key was:

`provider + provider item + normalized provider file/path + size`

No merging was performed using title, year, or episode.

## Duplicate representation

The assessment found:

- 2 duplicate groups;
- 4 Versions involved;
- 2 excess representations;
- no DELETE_CANDIDATE involved in those duplicates.

There was no significant evidence of duplicate recursion, repeated provider
file visits, duplicate inline/file-tree representations, or season-pack and
multifile duplication.

The 736 Versions therefore represent substantially distinct media files.

## Organizer comparison

The latest available Organizer snapshot reported approximately 732 media source
files, consistent with the approximately 735 fingerprints observed historically.

The current physical mount exposes 1,458 files with media extensions, but that
set includes operational representations and is not semantically equivalent to
Organizer discovery.

The available evidence supports 736 as the complete inventory. An exact
intersection with Organizer could not be calculated without exposing library
identifiers or relying on a shared persisted key that is not available.

## Legacy 520

The 520 baseline cannot be reconstructed as a documented canonical
transformation.

Historical comparison showed:

- 321 physical keys shared between snapshots;
- 413 keys only in the new inventory;
- 72 keys only in the historical baseline;
- 2 of the 11 historical DELETE_CANDIDATE keys represented in the new snapshot;
- none of the historical 11 remained a candidate under the new snapshot keys.

The snapshots are therefore not perfectly comparable. The most likely
explanation is an incomplete legacy inventory with partial season-pack/multifile
expansion and different metadata availability.

The value 520 must not be treated as the target cardinality.

## DELETE_CANDIDATE audit

All 70 candidates:

- belong to groups with at least one KEEP;
- have the sole reason `no_profile_slot`;
- pass the existing Policy Engine identity threshold;
- have no recoverability blocker;
- do not belong to technical duplicate groups;
- are distinct according to provider item/file/path/size evidence.

Classification:

- SAFE_POLICY_CANDIDATE: 70
- IDENTITY_UNCERTAIN: 0
- GROUPING_SUSPECT: 0
- DUPLICATE_REPRESENTATION: 0
- RECOVERABILITY_BLOCKED: 0
- OTHER_REVIEW_REQUIRED: 0

Four candidates have confidence 0.90, but remain above the existing policy
threshold and are not classified as REVIEW by the engine.

## Legacy DELETE_CANDIDATE comparison

- Still candidates: 0
- Represented in the new inventory: 2
- Changed/not represented as candidates: 11

The comparison does not establish that the 59 additional candidates are the
same historical candidates. They arise from a different, more complete
inventory population.

## REVIEW 152 → 37

The reduction is primarily explained by:

- more precise media filenames from the file tree;
- more specific fallback identity evidence;
- recoverability resolved at ProviderItem level;
- historical `recoverability_unknown` results;
- different Jellyfin/TMDb metadata availability.

Identity and Recoverability semantics were not modified.

## Policy

- Policy hash: `395cfa66603dc264`
- PRIMARY missing: 3
- REMOTE missing: 0

## Canonical classification

**A. 736 VALID_CANONICAL_INVENTORY**

Evidence:

- 736 Versions are almost all associated with unique physical/logical keys;
- only 2 technical excess representations were found;
- no DELETE_CANDIDATE derives from those duplicates;
- the cardinality is consistent with the historical full file-tree Organizer
  inventory;
- 520 is not a demonstrable canonical baseline.

No deduplication, policy changes, or artificial count adjustments were applied.

Provider DELETE: 0
Provider IMPORT: 0
Seerr POST: 0
