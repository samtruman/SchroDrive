# Multiversion Acquisition Assessment

## Status

This is a read-only assessment. No Seerr, Radarr, Sonarr, Prowlarr, provider,
download, import, or delete operation was executed.

## Current chain

`Media Manager Missing` derives needs from the canonical inventory and calls
`SeerrAcquisitionAdapter`. The adapter uses TMDb IDs and performs read-only
status checks against Seerr media and request endpoints. The current mutation
path, when explicitly enabled, supports movies only and submits a request
containing `mediaType` and `mediaId`. It does not submit a Quality Profile ID,
ARR server ID, root folder, or version-slot identifier.

TV status is observable, but the adapter explicitly models TV requests at
season scope and rejects mutation requests for non-movies. An episode-level
request is therefore not supported by the current contract.

ARR discovery preserves provider kind, server ID and profile ID. That mapping
is a SchröDrive retention association; it is not currently translated into a
Seerr request parameter.

## Evidence classification

### VERIFIED

- Seerr 3.4.1 exposes Radarr/Sonarr instances through its settings API.
- The installed runtime exposes two Radarr and two Sonarr quality profiles
  through the application discovery endpoint; Radarr profiles are returned
  by Seerr and Sonarr profiles use the dynamic, server-side read-only fallback.
- Movie status/request lookup is keyed by TMDb media ID.
- Duplicate protection uses a movie-level TMDb request scope.
- TV status matching can identify a requested season, but the request scope is
  not episode-level.
- The current executor is disabled in the deployed product.

### INFERRED FROM IMPLEMENTATION

- A movie already marked available is revalidated as `AVAILABLE` and blocks a
  new request, even if another retention slot is missing.
- Two ARR profiles cannot currently guarantee two physical versions because
  the request body does not carry the selected profile or ARR instance.
- Multiple ARR instances are discoverable and disambiguated in settings, but
  the current request path does not select a specific instance.
- A season pack or an individual episode cannot be safely requested as a
  distinct alternate version through the current Seerr adapter.

### NOT VERIFIED

- Whether the installed Seerr/Radarr combination can preserve two files for
  one movie under separate acquisition profiles.
- Whether a Radarr upgrade/downgrade path can be configured to retain an
  existing file while importing a second quality.
- Whether the current Sonarr configuration can retain parallel episode files
  without a separate instance/library arrangement.

### BLOCKED

- A real second-version acquisition test is blocked by the no-mutation rule.
- Direct raw Seerr media/request inspection was not used to create requests;
  only read-only application behavior and installed code were considered.

## Scenario matrix

| Scenario | Current result |
|---|---|
| Movie absent | Preview can identify an eligible movie request; execution remains disabled and acceptance is not live-verified. |
| Movie present, PRIMARY valid, REMOTE missing | Existing availability is detected; a second version is not guaranteed and is blocked by current semantics. |
| Both slots satisfied | No Missing requirement should be generated. |
| ARR present but SchröDrive identity unresolved | Canonical identity/reconciliation remains authoritative; no safe acquisition should be inferred. |
| TV second quality | Preview is season-scoped; mutation path rejects TV. |
| Season pack plus episode alternative | Not supported safely by the current contract. |
| Different ARR profiles | Stored for retention mapping, but not transmitted to Seerr request. |
| Multiple ARR instances | Discovery preserves server IDs; request routing is not yet instance-selectable. |

## Alternatives

| Alternative | Compatibility | Main risk/requirement |
|---|---|---|
| One ARR instance with multiversion retention | Not demonstrated | Must prove ARR preserves parallel files and exposes deterministic imports. |
| Separate ARR instances for PRIMARY/REMOTE | Plausible but not verified | Requires explicit Seerr server routing, libraries/root folders, and collision tests. |
| Seerr first request, separate version path | Partial | Needs a real, safe second-version executor and duplicate protection. |
| SchröDrive-coordinated acquisition with ARR search | Future | Requires a verified ARR command contract without inventing an indexer engine. |
| Hybrid | Most flexible | Highest coordination complexity; requires per-item reconciliation and physical preservation guarantees. |

## Recommendation

Do not enable multiversion acquisition execution yet. Keep Missing previews
explicitly marked unsupported when the requested retention slot would require a
second physical version. The next controlled experiment should use disposable
ARR libraries and fixture media, verify profile/server routing, observe import
paths and collision behavior, and prove that the existing compliant version is
preserved before any production capability is enabled.
