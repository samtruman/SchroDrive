# CURRENT STATUS

STANDARD_RUNTIME: VALIDATED  
MEDIA_MANAGER_CANONICAL_INVENTORY: VALIDATED  
MEDIA_MANAGER_POLICY_HASH: VALIDATED  
MEDIA_MANAGER_POLICY_EDITOR: VALIDATED  
READY_FOR_SINGLE_DELETE_E2E: YES  
SINGLE_DELETE_RESTORE_E2E: VALIDATED

Canonical baseline:

- Versions: 736
- VersionGroups: 632
- KEEP: 629
- DELETE_CANDIDATE: 70
- REVIEW: 37
- PRIMARY missing: 3
- REMOTE missing: 0
- Policy hash: `298a80b293d19046`

Single Delete candidate:

- Love And Monsters (2020)
- Decision: `DELETE_CANDIDATE`
- Confidence/provenance: `0.98` / filename
- Single-file: YES
- Derived Versions: 1
- Isolated ProviderItem: YES
- Surviving KEEP distinct: YES
- Recoverability: `RECOVERABLE`
- Restore material: READY

Runtime:

- Standard SchröDrive runtime active
- `validationMountPrecheck`: PASS
- Delete Preview: HTTP 200, approximately 3.13 s

Safety:

- Provider DELETE: 1
- Provider IMPORT: 1 attempt
- Seerr POST: 0

# OPEN ITEMS

- Review the single-delete/restore outcome and reconciliation rule
- Preparazione MVP/PR dopo E2E

# HISTORY

- **2026-09-29 — Canonical inventory e Policy Editor validated**  
  Full file-tree inventory e decision configuration hash validati. La baseline
  corrente è 736/632/629/70/37/3/0 con hash `298a80b293d19046`.

- **2026-09-29 — Single Delete preflight review**  
  Il preflight non è entrato nel runtime MVP: la decisione resta quella del
  Policy Engine e l’executor provider rimane disabilitato.

- **2026-09-29 — AllDebrid 502 diagnosis**  
  AllDebrid direct API healthy: `magnet/status` e `magnet/files` HTTP 200.
  Il 502 era causato dal vecchio validation-runtime, che non esponeva le
  route Media Manager e restituiva 404 HTML al Web proxy.

- **2026-09-29 — Standard runtime restored**  
  Il thin wrapper esegue `validationMountPrecheck` prima del normale runtime
  SchröDrive. Precheck PASS, API Media Manager HTTP 200 e baseline corrente
  confermata.

- **2026-09-29 — Single Delete + Restore E2E**  
  Love And Monsters è stato cancellato una sola volta dopo preflight valido.
  Il restore è stato tentato una sola volta tramite MigrationImporter, ma
  AllDebrid ha restituito timeout durante `addMagnet`; restore non confermato.
  Nessun ulteriore tentativo è stato eseguito.

- **2026-09-29 — Single Delete + Restore E2E reconciled**  
  La verifica diretta ha confermato il ProviderItem restaurato; la verifica
  finale Media Manager ha riconciliato infohash, media file, Version e
  VersionGroup sulla baseline 736/632/629/70/37/3/0. Dopo timeout ambiguo di
  `addMagnet`, la regola operativa è riconciliare prima tramite infohash e non
  ritentare automaticamente.

- **2026-09-29 — MVP cleanup**  
  Mantenuti il file-tree AllDebrid e il mapping MigrationExporter emersi
  dall’E2E; rimossi dal runtime i residui del framework preflight non utilizzato.

## Superseded classifications

Le seguenti classificazioni storiche non rappresentano lo stato corrente:

- `NO_SAFE_CANDIDATE` — SUPERSEDED
- `NO_SUITABLE_MOVIE_CANDIDATE` — SUPERSEDED
- `NO_PROVIDER_UNSTABLE` — SUPERSEDED
- `PARTIAL_EXTERNAL_BLOCKER` — SUPERSEDED
