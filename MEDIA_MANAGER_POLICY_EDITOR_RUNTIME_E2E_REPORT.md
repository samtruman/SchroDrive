# Media Manager — Policy Editor Runtime E2E Report

## Standard runtime

- Standard runtime: avviato temporaneamente
- `validationMountPrecheck`: passato
- Health: healthy
- Delete Preview iniziale: completato in circa 740 ms

Canonical inventory confermato prima del test:

- Versions: 736
- VersionGroups: 632
- KEEP: 629
- DELETE_CANDIDATE: 70
- REVIEW: 37
- PRIMARY missing: 3
- REMOTE missing: 0
- Policy hash: `395cfa66603dc264`

Durante la rivalutazione successiva AllDebrid ha iniziato a restituire timeout
sulle chiamate inventory/file-tree. Il Delete Preview finale non ha completato
entro 120 secondi.

Il runtime è stato rollbackato al validation-runtime precedente ed è healthy.

## Policy Editor E2E

Il payload policy originale è stato salvato e successivamente ripristinato.

Modifica temporanea:

- profile: PRIMARY
- field: `resolution`
- operator: `equals`
- value: `2160p`
- weight: `1`

Round-trip:

- salvataggio backend: riuscito;
- reload: riuscito;
- struttura scoring preservata;
- profilo REMOTE invariato.

Il primo test con la sola modifica scoring non ha cambiato l’hash, perché
l’implementazione corrente calcola l’hash dal solo blocco `policy`, non dai
profili.

Per completare il test è stata applicata temporaneamente anche:

- `policyVersion`: `1 → 2`
- hash temporaneo: `495922399c31364a`

La rivalutazione Delete Preview in questo stato è stata bloccata dai timeout
AllDebrid.

## Restore

Ripristino esatto eseguito tramite API:

- policy hash finale verificato: `395cfa66603dc264`;
- scoring temporaneo rimosso;
- `policyVersion`: `1`;
- REMOTE invariato e disabilitato.

## Settings navigation

Non validata runtime in questo passaggio, perché il blocco provider ha impedito
il completamento della validazione finale.

## Test / build

- `git diff --check`: passato
- Nessun nuovo codice modificato durante questo tentativo
- Nessun nuovo build necessario dopo il rollback
- Suite/typecheck/build precedenti: già passati sul commit di lavoro

## Commit

Nessun commit creato.
Nessun push eseguito.

## Safety

- Provider DELETE: 0
- Provider IMPORT: 0
- Seerr POST: 0

## Esito

`MEDIA_MANAGER_CANONICAL_INVENTORY: VALIDATED`

`MEDIA_MANAGER_POLICY_EDITOR: BLOCKED — provider timeout durante la rivalutazione finale`

`STANDARD_SCHRODRIVE_RUNTIME: ROLLBACKED`
