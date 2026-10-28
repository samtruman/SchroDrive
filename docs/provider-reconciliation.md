# Provider reconciliation

SchröDrive's provider reconciliation layer is provider-agnostic. It consumes
the existing `DebridProvider` contract and never calls provider delete, repair,
or dead-scanner operations.

For provider items added directly to AllDebrid, reconciliation uses the same
download-staging contract as the qBittorrent-compatible Arr bridge. SchroDrive
creates temporary provider-backed symlinks below `ARR_DOWNLOADS_PATH/radarr`
or `ARR_DOWNLOADS_PATH/sonarr`, then submits `DownloadedMoviesScan` or
`DownloadedEpisodesScan`. Radarr/Sonarr owns the title match, final folder,
rename, and import. SchroDrive does not invent a canonical folder for this
path.

Before the scan command is sent, SchröDrive waits for every file in the provider
tree to become visible and readable through the mounted provider path. The wait
uses PROVIDER_RECONCILIATION_MOUNT_READY_TIMEOUT_MS (default 30 seconds) and
PROVIDER_RECONCILIATION_MOUNT_READY_POLL_MS (default 500 ms). If the mount is
still stale after the timeout, the event is deferred instead of sending ARR an
empty staging directory. Before polling, the local WebDAV bridge refresh endpoint
is called so a newly-added provider item can invalidate the directory cache.

At process startup, when `RUN_MOUNT=true`, SchröDrive also waits for the mount
roots themselves to be real, readable mountpoints before starting the organizer
watch or the provider-reconciliation worker. This prevents the first startup
scan from racing rclone/FUSE initialization. Configure the gate with
`STARTUP_MOUNT_READY_TIMEOUT_MS` (default 120 seconds) and
`STARTUP_MOUNT_READY_POLL_MS` (default 1 second). If the gate expires, the
dependent services start with their existing fail-closed guards and log the
reason and path that were still unavailable.

When a provider item is deleted, both staging and any existing Arr-library
symlinks are removed and the affected movie/series is rescanned. The standalone
organizer fallback remains available only when Arr integration is unavailable
or not configured.

The periodic organizer/reconciliation pass is idempotent: Sonarr/Radarr is
asked to rescan only when a symlink was created or moved, or when the
authoritative ARR library path was repaired. A pass that finds everything
already in the correct location does not enqueue another ARR scan.
TV specials are treated as season `0` and remain under `Season 00` in both
organizer and ARR reconciliation paths.

Normal provider additions are handled by the automatic reconciliation worker.
Every recent pass reads the lightweight provider torrent/ID list and compares
it with the persisted intake state: IDs present only in the provider are
additions, IDs missing from the provider are removals, and active known items
are eligible for a changed-tree check. Directory trees are fetched only for
new or active items; completed, unchanged items are not deep-scanned again.
The changed provider paths are then passed to the organizer without walking
the complete mount or pruning unrelated links. `RUN_ORGANIZER_WATCH` is
disabled by default in Docker and is reserved for intentional full recovery
scans. The Dashboard/provider refresh remains an explicit on-demand trigger,
not a prerequisite for normal automatic processing.

If a provider reuses an item ID after deletion, the persisted lifecycle state
allows the same file tree to be processed again; the previous `added` event is
not treated as a duplicate of the new post-deletion addition.
```text
provider listTorrents/fetchDirectories
  -> normalized snapshot and local SQLite diff
  -> mount-backed symlink in downloads/radarr or downloads/sonarr
  -> DownloadedMoviesScan / DownloadedEpisodesScan
  -> Radarr/Sonarr creates the final library path and imports the file
  -> Jellyfin sees the ARR-managed library
```

## Shared TMDb identity and Arr library paths

The Organizer uses a canonical TMDb-derived path only as its standalone
fallback (`Movies/<TMDb title> (year)` or `TV/<TMDb title> (year)/Season NN`)
and preserves the original release filename. The direct provider flow does
not use that fallback: ARR receives the staging path and owns the identity and
final folder decision.

This prevents a localized Arr title such as `Wolfs - Lupi Solitari (2024)`
from becoming a second library folder beside the ARR-managed folder. Provider
content remains on the mount and is never copied or deleted by reconciliation;
only the temporary staging symlink and ARR import lifecycle are involved.
Only paths below the configured download staging root are used for the direct
import path.


When both Radarr and Sonarr are configured with a URL and API key, the worker
starts automatically. `PROVIDER_RECONCILIATION_ENABLED=true` can still be used
to force it on, while an explicit `false` disables automatic activation.

## Bootstrap reconciliation edge cases

Provider mounts that expose category directories and an aggregate __all__ directory are scanned through the category directories only. Every direct, non-hidden category directory is eligible, including custom categories; the aggregate __all__ and compatibility links directories are never combined with authoritative roots. If no category root exists, __all__ (then links) is retained as a legacy fallback. This prevents an Arr-reconciled file from being imported a second time through an aggregate alias while preserving older provider layouts. Existing aggregate aliases are removed only when the corresponding category-root link is present in the same organised folder.

Alias reconciliation compares the complete provider-relative media path, not only the final filename. This keeps two different sources with the same leaf name from being treated as the same media item.

ARR parser identity is authoritative when Arr can parse the release filename and the parsed entity is configured. Without a parser match, a title match is accepted only when its year is equal or within +/-1 year; a distant year mismatch (for example, a remake with the same title) is not linked automatically. Arr metadata lookup remains the final identity fallback. Ambiguous or unresolved items are left unlinked, never placed in a guessed folder.
## Contract coverage

Every provider registered by SchröDrive implements the common provider
contract used by the worker: stable torrent IDs, normalized torrent files, a
completed virtual directory tree, and a provider mount path. Recent polling is
an optimization; full polling plus the local snapshot diff is the source of
truth.

| Provider | Contract adapter | Live reconciliation validation |
| --- | --- | --- |
| TorBox | common adapter | pending provider-backed test |
| Real-Debrid | common adapter | pending provider-backed test |
| AllDebrid | common adapter | validated with provider-backed Sonarr E2E |
| Premiumize | common adapter | pending provider-backed test |
| Debrid-Link | common adapter | pending provider-backed test |
| Deepbrid | common adapter | pending provider-backed test |
| Offcloud | common adapter | pending provider-backed test |
| Put.io | common adapter | pending provider-backed test |
| MegaDebrid | common adapter | pending provider-backed test |
| Seedr | common adapter | pending provider-backed test |
| PikPak | common adapter | pending provider-backed test |

“Common adapter” means the provider satisfies SchröDrive's existing interface;
it does not claim that a live account has been tested. A provider is skipped
when it is not configured or cannot expose a complete read-only snapshot.

The Arr library contains symlinks only. Provider content remains on the mount;
the reconciliation layer does not download or copy media to local storage.

## Mount refresh after provider additions

After SchröDrive adds a torrent directly to a provider, the provider mount is
refreshed before the reconciliation worker asks Radarr or Sonarr to scan. The
refresh targets the configured rclone remote and waits for the new provider
path to become visible. This prevents an ARR scan from racing the mount cache
and reporting a newly completed file as missing.

The same refresh is also performed by the dashboard/provider refresh path. A
dashboard refresh therefore re-reads the provider inventory and refreshes the
mount; it is not merely a client-side reload of cached cards. Existing files
are not copied or downloaded, and the ARR-visible result remains a symlink.

## Organizer and media-server refresh

After reconciliation makes a provider item available, the Organizer creates or
updates the corresponding symlink in the configured movie/series library. When
the Organizer actually changes the library, it can request a library refresh
for each configured media server independently:

- `REFRESH_JELLYFIN_ON_ADD=true` refreshes Jellyfin;
- `REFRESH_PLEX_ON_ADD=true` refreshes Plex.

Both settings default to enabled and are editable in Settings → Organizer.
They are evaluated only after a real symlink addition, replacement, or stale
entry removal; an unchanged periodic scan does not repeatedly refresh servers.
Missing credentials or an unreachable optional server do not block provider
reconciliation.

### Idempotent ARR path repair

When title/year matching is missing or ambiguous, reconciliation asks the configured Sonarr or Radarr \/api\/v3\/parse endpoint to resolve the release filename and then matches the returned ARR entity ID. TMDB remains the last fallback; genuinely unresolved identities stay in the review queue.

ARR reconciliation is safe to repeat. When an existing organized destination already points to the same provider source, the stale alias is removed instead of being retained as a duplicate. After an ARR move, empty season/title parent directories under the organized library are removed immediately; library roots such as Movies, TV, and Anime are preserved. The operation never removes provider content or a non-empty directory.

The older generic `REFRESH_LIBRARY_ON_ADD` setting is not the control for this
path. It must not be used as a substitute for the server-specific settings.


### Mount readiness and rclone refresh

Before submitting a direct file to Radarr or Sonarr, reconciliation refreshes
the provider WebDAV bridge and requests a targeted rclone VFS refresh. Set
`MOUNT_RCLONE_RC_PORT` (for example `5579`) to enable rclone's local RC
endpoint; the mount process starts it on loopback only.
`PROVIDER_RECONCILIATION_MOUNT_REFRESH_URL` refreshes the bridge, while the RC
refresh invalidates the mount directory cache. Reconciliation then waits for
the provider files to become readable, bounded by
`PROVIDER_RECONCILIATION_MOUNT_READY_TIMEOUT_MS`.
