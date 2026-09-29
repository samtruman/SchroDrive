# Media Manager — Policy Hash Report

## Policy hash audit

Previously the hash included only:

- `enableRemote`;
- `acquireMissingRemote`;
- safety policy;
- `policyVersion`.

It did not include the persisted decision configuration represented by:

- `VersionProfile[]`;
- legacy and structured scoring;
- hard requirements;
- enabled/disabled state;
- priority;
- target and preferred resolution;
- source/codec/audio ordering;
- language requirements and preferences;
- ANY/ALL;
- ORIGINAL;
- language scope;
- max bitrate/size.

## Fix

`versionManagerPolicyHash(policy, profiles)` now hashes the complete decision
configuration with deterministic canonical serialization.

Normalization includes:

- canonical rule trees;
- normalized operator aliases;
- order-independent AND/OR children;
- order-independent IN values;
- order-independent scoring rules;
- deterministic object property ordering;
- preserved ordering for semantically ordered lists.

Secrets, credentials, provider runtime data, and UI-only profile metadata are
not included.

`policyVersion` is excluded from the content hash and remains revision/schema
metadata.

All main consumers use the same hash function:

- status;
- preview;
- Delete Preview;
- preview audit.

## Hash validation

- Legacy hash: `395cfa66603dc264`
- Canonical hash for the original payload: `298a80b293d19046`
- Temporary scoring-only hash: `2515e7a5b916fc41`

Temporary change:

`PRIMARY / resolution equals 2160p / weight 1`

The hash changed without changing `policyVersion`.

Restoring the original payload returns the deterministic original canonical
hash: `298a80b293d19046`.

## Tests and builds

- Targeted policy/hash tests: 21 pass
- Full suite: 242 pass
- Assertions: 613
- Typecheck: passed
- Backend build: passed
- Web build: not required; no Web files changed
- `git diff --check`: passed
- Privacy delta check: no secrets, tokens, magnets, infohashes, or provider
  IDs detected

## Runtime

The canonical runtime baseline had already been confirmed:

- Versions: 736
- VersionGroups: 632
- KEEP: 629
- DELETE_CANDIDATE: 70
- REVIEW: 37
- PRIMARY missing: 3
- REMOTE missing: 0

The standard runtime passed `validationMountPrecheck`, was healthy, and
confirmed the canonical baseline before the final round-trip. The temporary
Policy Editor preview also completed with the same inventory counts and hash
`2515e7a5b916fc41`.

After exact restore, status returned hash `298a80b293d19046`. A final
post-restore Delete Preview was attempted once, but AllDebrid became unstable
again and returned inventory/file-tree timeouts. No polling, timeout, or
provider configuration was changed.

## Safety

- Provider DELETE: 0
- Provider IMPORT: 0
- Seerr POST: 0
- Delete Executor: not implemented
- PR/push: none

## Status

`MEDIA_MANAGER_POLICY_HASH: VALIDATED`

`MEDIA_MANAGER_POLICY_EDITOR: PARTIAL_EXTERNAL_BLOCKER`
