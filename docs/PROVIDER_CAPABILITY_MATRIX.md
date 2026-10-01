# Provider Capability Assessment

Assessment date: 2026-10-01.

The migration core consumes explicit capability declarations. API support and
validation are separate: a documented operation may be implemented and
contract-tested without being E2E validated on the current account.

Validation levels: `IMPLEMENTED`, `CONTRACT_TESTED`, `INTEGRATION_TESTED`,
`E2E_VALIDATED`, `UNVALIDATED`.

Support levels: `SUPPORTED`, `PARTIAL`, `UNSUPPORTED`, `UNKNOWN`.

## Official sources

| Provider | Official documentation | Notes |
|---|---|---|
| AllDebrid | https://docs.alldebrid.com/ | v4/v4.1 magnet upload, torrent upload, status, files, delete and restart. |
| Real-Debrid | https://api.real-debrid.com/ | Official torrent list/info, add magnet/torrent, select files and delete endpoints. |
| TorBox | https://api.torbox.app/docs | Official Swagger/OpenAPI surface; current account reports `Upgrade to Access API`. |

## Capability matrix

| Provider | Capability | API support | Validation | Limitation |
|---|---|---|---|---|
| AllDebrid | inventory, file tree, infohash, magnet export, recoverability, status | SUPPORTED | E2E_VALIDATED | Current source/export path validated. |
| AllDebrid | import magnet | SUPPORTED | E2E_VALIDATED | Single reverse restore validated; no bulk import in this assessment. |
| AllDebrid | duplicate lookup, post-import verification | SUPPORTED | E2E_VALIDATED | Reverse restore produced a target item and the second preview detected its equivalent hash. |
| AllDebrid | import torrent | SUPPORTED | CONTRACT_TESTED | No real torrent-file import in this assessment. |
| AllDebrid | cache lookup | UNKNOWN | UNVALIDATED | No separate documented cache-check path used by the adapter. |
| AllDebrid | delete | SUPPORTED | E2E_VALIDATED | Media Manager executor performs guarded ProviderItem deletion; provider timeouts are reconciled as unknown outcomes before retry. |
| Real-Debrid | inventory, infohash, duplicate lookup, status | SUPPORTED | E2E_VALIDATED | Target inventory and single import E2E validated. |
| Real-Debrid | file tree | SUPPORTED | INTEGRATION_TESTED | Source file-tree behavior is not a cross-provider export E2E. |
| Real-Debrid | magnet export, recoverability | SUPPORTED | E2E_VALIDATED | Reverse restore validated canonical magnet reconstruction from infohash; original complete magnet data is not guaranteed. |
| Real-Debrid | import magnet, post-import verification | SUPPORTED | E2E_VALIDATED | Cross-provider target path was already validated. |
| Real-Debrid | import torrent | SUPPORTED | CONTRACT_TESTED | No new real mutation performed. |
| Real-Debrid | cache lookup | UNKNOWN | UNVALIDATED | Not exposed as a separately validated adapter capability. |
| Real-Debrid | delete | SUPPORTED | CONTRACT_TESTED | Exposed through the guarded Media Manager executor; no production deletion was used for this assessment. |
| TorBox | inventory, file tree, infohash, status, import magnet/torrent, duplicate lookup, post-import verification, delete | SUPPORTED | UNVALIDATED | Documented API surface, but API access is unavailable on the current Free account. |
| TorBox | magnet export, recoverability | PARTIAL | UNVALIDATED | Depends on hash/metadata returned by the account/API response. |
| TorBox | cache lookup | SUPPORTED | UNVALIDATED | Documented API capability; no live account validation. |

TorBox is not classified as universally unsupported. No upgrade, scraping,
session-cookie workaround, or unauthorised call was attempted.

## Migration route matrix

| Source → target | Support | Validation | Reason |
|---|---|---|---|
| AllDebrid → Real-Debrid | SUPPORTED | E2E_VALIDATED | Only route exercised with a real export, target preview and controlled restore. |
| Real-Debrid → AllDebrid | SUPPORTED | E2E_VALIDATED | One real recoverable item restored; file-tree completeness remains a separate limitation. |
| TorBox → AllDebrid | SUPPORTED | UNVALIDATED | Requires TorBox API access. |
| AllDebrid → TorBox | SUPPORTED | UNVALIDATED | Requires TorBox API access. |
| Real-Debrid → TorBox | SUPPORTED | UNVALIDATED | Requires TorBox API access and source export assessment. |
| TorBox → Real-Debrid | SUPPORTED | UNVALIDATED | Requires TorBox API access. |
| Routes involving undeclared future providers | UNKNOWN | UNVALIDATED | Fail closed until an adapter declaration and tests exist. |

The UI derives route availability from these declarations; it does not use a
hardcoded provider-pair whitelist. Unsupported/unknown capabilities block
preview, while supported but unvalidated capabilities remain visibly marked
as unvalidated rather than being promoted to E2E status.

Delete availability is provider-specific and controlled by the Media Manager
Safety dry-run flag. Execution always targets one ProviderItem on the selected
provider and never compares or removes a copy held by another provider.
