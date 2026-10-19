# Provider reconciliation

SchröDrive's provider reconciliation layer is provider-agnostic. It consumes
the existing `DebridProvider` contract and never calls provider delete, repair,
or dead-scanner operations.

The organizer performs an Arr path-reconciliation phase after every provider
organization pass. This covers the initial AllDebrid library bootstrap and
later AllDebrid manifest additions without requiring a manual migration. When
Radarr/Sonarr are available, existing SchroDrive symlinks are moved to the
authoritative Arr `path`, and the affected movie/series is rescanned. When Arr
is unavailable or not configured, the standalone SchroDrive canonical path is
kept and reconciliation is retried on a later pass.

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

When both Radarr and Sonarr are configured with a URL and API key, the worker
starts automatically. `PROVIDER_RECONCILIATION_ENABLED=true` can still be used
to force it on, while an explicit `false` disables automatic activation.

## Bootstrap reconciliation edge cases

The initial organizer pass also reconciles links that were created before
Radarr/Sonarr integration was available. Release-like directory names are not
treated as authoritative identities: the file basename and TMDb/ARR identity
are used to resolve the record, then the symlink is moved to the ARR-owned
library path.

This includes numeric movie titles whose release name uses a form such as
`1917.(2019).2160p...`. The numeric title and the parenthesized year must be
parsed separately; otherwise the release tokens can be mistaken for the media
title or year.


The release year is secondary identity evidence, not a hard filter. A unique Radarr/Sonarr title match is authoritative even when the release filename year differs from the catalog year, for example an Eden release dated 2024 catalogued by Radarr as Eden (2025). The year remains a disambiguator when multiple ARR records share the same title.

A rescan is requested once per matched movie or series during each organizer
pass, even when the symlink is already under the correct path. This allows
Sonarr/Radarr to register files that existed before the reconciliation pass.
The operation remains symlink-only: provider-backed files are never copied or
deleted. If an ARR path is unavailable, the item is deferred and the
standalone organizer does not create a competing fallback path.

Live validation on 2026-10-15 confirmed the behavior with:

- Radarr: `1917` moved from a release-like folder into
  `Movies/1917 (2019)` and became associated;
- Sonarr: Widow's Bay increased from 2 to 10 registered episode files;
- 241 existing symlinks were reconciled without physical media copies.

Live validation on 2026-10-19 confirmed the year-mismatch case with AllDebrid and Radarr:

- Eden release dated 2024 was initially under Movies/Eden (2024) while Radarr authoritative record was Eden (2025).
- The organizer moved the symlink to Movies/Eden (2025) without copying or deleting provider media.
- The pass moved 9 symlinks in total and Radarr reported hasFile=true for Eden afterwards.

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

The older generic `REFRESH_LIBRARY_ON_ADD` setting is not the control for this
path. It must not be used as a substitute for the server-specific settings.
