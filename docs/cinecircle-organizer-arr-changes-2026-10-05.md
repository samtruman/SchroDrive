# CineCircle organizer and Arr integration changes — 2026-10-05

This document records the changes deployed to the CineCircle SchröDrive
runtime during the afternoon of 2026-10-05.

## Organizer behavior

- The DavDebrid/Plex filename parser is consulted before the generic
  SchröDrive filename heuristics. This preserves movie years such as `2024`
  as movie metadata instead of treating them as absolute episode numbers.
- Multi-episode releases preserve both the first and last episode number.
- A TV release without a year may reuse an existing `Title (YYYY)` directory
  only if there is exactly one normalized match. If there is no unique match,
  the file is left in the provider's generic view and recorded for review.
- Provider aliases for the same file (`__all__` and `shows`) no longer create a
  collision suffix when basename and size identify the same source. The
  organizer continues to create symlinks only; source files are not rewritten.

## Arr notification flow

When the organizer creates a new symlink, it collects the affected canonical
movie or series path. After the pass completes it looks up the matching record
in Radarr or Sonarr and sends one targeted command:

| Media | Arr command |
|---|---|
| TV series | `RescanSeries` |
| Movie | `RescanMovie` |

The notification is best-effort and rate-limited for 60 seconds per Arr
entity. It is intended to make Arr notice newly organized files; it does not
perform a download, import, rename, move, or delete operation. Arr remains
responsible for metadata matching and its own database state.

The organizer still runs on its configured polling interval. Therefore this is
an automatic post-organization push, not a provider-side real-time event
stream: a new provider file is notified as soon as a subsequent organizer
pass discovers and links it.

The qBittorrent-compatible Arr bridge also validates season/episode identity
before using its fuzzy provider-folder fallback. This is required because the
first characters of every episode in the same series are often identical. A
folder for `S02E01` can no longer satisfy a request for `S02E02` merely because
the release title prefix matches.

## Production verification

After deployment, The Boys season 4 episodes 4 and 5 were added to AllDebrid.
Both were discovered and linked at:

```text
organized/TV/The Boys (2019)/Season 04/
```

The resulting links point to the AllDebrid `__all__` source view. Episodes 1–3
remain in the same canonical year-qualified directory. No duplicate title-only
directory was created and the source media was not overwritten.

## Operational notes

- A rescan is emitted only when a new organized symlink is actually created;
  an already existing link does not produce another Arr command.
- If the provider exposes the same file through another mount alias, the
  organizer must compare the canonical source identity before declaring a
  collision.
- Ambiguous title/year matches are intentionally conservative and require
  review rather than automatic folder creation.
