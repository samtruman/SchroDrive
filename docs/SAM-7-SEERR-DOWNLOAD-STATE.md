# SAM-7: persisted Seerr download recovery

## Cause and change

Production read-only inspection on 2026-10-13 confirms Backrooms remains in
qBittorrent-compatible state `error`, progress 0 and size 0. The bridge matched
release names and excluded errors from subsequent polling. The original
provider failure remains unknown; the screenshot and prior Radarr inspection
report a file already imported.

Match accepted submissions by provider-scoped torrent ID, retry persisted
errors, and count missing polls only after an authoritative provider response.
AllDebrid, RealDebrid and TorBox expose fresh inventory failure while existing
callers keep cache fallback. Persist name/counter changes. Completed
mountScanned records, SQLite schema, categories, configurable staging and
absolute links remain preserved.

## Consolidated release

Recovered the job-12 SAM-7 diff onto canonical checkout
`/home/samtruman/projects/schrodrive`, branch `fix/sam-7-canonical-job-12`,
base `3f33d04`. The older `5b8aeb3` job worktree is only the patch source.
Canonical commits after that base include the owner's organizer updates and
are retained. Five of the six formerly divergent runtime modules match the
canonical build byte-for-byte; organizer differs by the retained FUSE-safe
reconciliation/original-release-name updates. OCI revision on the old image
identifies Bun, not SchroDrive.

Typecheck, backend build and complete configured suite pass: 363 tests,
0 failures, 926 assertions across 55 files. Integration covers outages,
persisted errors, provider IDs after rename, restart persistence, mountScanned,
configured staging and absolute links. Full Dockerfile build also builds the
frontend inside Docker; never build into the production-mounted host `.next`.
The obsolete overlay recipe is not a release artifact.

## Approval runner requirements and rollback

Before replacing the container, create a mode-0700 backup directory in the
runner's protected backup storage. Use SQLite online backup for every database
under `/data` (including WAL state), run `PRAGMA integrity_check` on each copy,
and save the config/data tree, active Compose, current container mount/command
contract, old image ID, and production-mounted frontend. Preserve the exact
old image `sha256:8ef463c3e4effc4df9d7806870669b20da6dbce8a6f32d41409aed92234490d1`.
Do not log credentials or archive them into Git. Backup creation and any
frontend synchronization are approval-time operations.

Deploy the prebuilt full-checkout image only through the bridge. Preserve
/data, /config, the identical absolute downloads bind, /mnt/schrodrive rshared,
and the read-only /app/web/.next contract. If synchronizing the frontend bind,
use the exact frontend from the approved image after backing up its predecessor.
No database migration is required. Do not invoke the historical deployment
script: it rebuilds an image and synchronizes a obsolete source mount.

After approval require container healthy, GET :8970/health ok=true, bridge
:8972/health, provider readiness via read-only status, mount visibility,
configured staging, absolute symlink targets, persisted torrent categories and
mountScanned state. Observe Backrooms transition from error through completed
mount discovery, then Radarr queue and Seerr convergence using read-only GETs.
Allow bounded cold-start inventory readiness; do not accept health alone as
reconciliation success. On failure the runner must restore the previous image,
Compose/frontend contract and verify old health. Preserve databases unless a
restore is actually necessary; restore only from the verified consistent copy.

Residual risks: provider availability/rate limits, cold-start inventory time,
and the already-retained organizer changes. Real Seerr convergence remains
unverified until the authorized rollout. No production state was modified.
