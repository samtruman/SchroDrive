# Provider reconciliation

SchröDrive's provider reconciliation layer is provider-agnostic. It consumes
the existing `DebridProvider` contract and never calls provider delete, repair,
or dead-scanner operations.

The organizer resolves the Arr path before creating each provider
symlink. This covers the initial AllDebrid library bootstrap and later
AllDebrid manifest additions without requiring a manual migration. When
Radarr/Sonarr are available, the existing library path is authoritative from
the first placement and the affected movie/series is rescanned. Existing links
are also reconciled on later passes for migration safety. When Arr is
unavailable or not configured, the standalone SchroDrive canonical path is
used and Arr resolution is retried on a later pass.
```text
provider listTorrents/fetchDirectories
  -> normalized snapshot and local SQLite diff
  -> mount-backed symlink in the Arr library
  -> RescanMovie / RescanSeries
  -> Radarr, Sonarr, Plex and Jellyfin see the same provider-backed file
```

## Shared TMDb identity and Arr library paths

The Organizer uses a canonical TMDb-derived path as its standalone fallback
(`Movies/<TMDb title> (year)` or `TV/<TMDb title> (year)/Season NN`) and
preserves the original release filename. When an Arr record is found by TMDb
ID, its existing library `path` is authoritative instead; SchroDrive creates
the symlink there and asks the relevant Arr service to rescan it. The TMDb ID
remains the stable identity, while the folder name remains an Arr-owned
presentation detail when Arr integration is enabled.

This prevents a localized Arr title such as `Wolfs - Lupi Solitari (2024)`
from becoming a second library folder beside the Organizer's
`Wolfs (2024)`. Existing links are reconciled automatically and only the
symlink is moved; provider-backed media is never copied or deleted.
The initial-placement rule is important: ARR reconciliation is not a cleanup
phase that runs after generic canonical placement. The organizer loads the
configured Radarr/Sonarr library records once per pass, resolves each media
item by ARR title/alias, parser identity, or the existing TMDb fallback, and
uses the resolved ARR library directory before writing the symlink. This
prevents repeated scans from alternating between a generic canonical folder
and the ARR folder, which could make Sonarr/Radarr lose file associations.
Only paths below the configured organized/Movies or organized/TV roots are
accepted; release-like or unsafe ARR paths fall back to normal review.


When both Radarr and Sonarr are configured with a URL and API key, the worker
starts automatically. `PROVIDER_RECONCILIATION_ENABLED=true` can still be used
to force it on, while an explicit `false` disables automatic activation.

## Bootstrap reconciliation edge cases

Provider mounts that expose category directories and an aggregate __all__ directory are scanned through the category directories only. Every direct, non-hidden category directory is eligible, including custom categories; the aggregate __all__ and compatibility links directories are never combined with authoritative roots. If no category root exists, __all__ (then links) is retained as a legacy fallback. This prevents an Arr-reconciled file from being imported a second time through an aggregate alias while preserving older provider layouts. Existing aggregate aliases are removed only when the corresponding category-root link is present in the same organised folder.

Alias reconciliation compares the complete provider-relative media path, not only the final filename. This keeps two different sources with the same leaf name from being treated as the same media item.

ARR parser identity is authoritative when Arr can parse the release filename and the parsed entity is configured. Without a parser match, a title match is accepted only when its year is equal or within +/-1 year; a distant year mismatch (for example, a remake with the same title) is not linked automatically. Arr metadata lookup remains the final identity fallback. Ambiguous or unresolved items are left unlinked, never placed in a guessed folder.
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
