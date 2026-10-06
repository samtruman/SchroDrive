# UPSTREAM_PLAN

## CURRENT STATUS

- Integration validation: `FULL_E2E: VALIDATED` at `51af6c4`.
- Contribution base: `upstream/develop`.
- Generic PRs #100–#106: `OPEN` unless explicitly marked otherwise; they are
  not assumed present in upstream/develop.
- Media Manager PR splitting: not started.

This file is planning/tracking only. Runtime evidence, local deployment files
and provider data are excluded from upstream extraction.

Assessment della branch rispetto a `upstream/develop`.

Contribution standard: tutte le nuove upstream PR devono targettare
`develop`; `main` è release-only salvo istruzione esplicita del maintainer.

Merge-base corrente:

`f6f20d52cddca44529e225128095a13c97c0e428`

The first upstream contribution batch is now published against `develop`.
The Media Manager worktree remains separate; this document contains planning
and tracking only.

## STANDALONE_PRS

### 1. Organizer collision safety

- Titolo: `fix(organizer): preserve colliding media versions`
- Commit sorgente: `e7cf2de`; PR #100 riallineata su `develop` con commit
  `611c6d1d22f75b74edaba5f06d98ef7a24ca6ec3`.
- Problema: una versione poteva rimuovere il symlink di un'altra versione con
  destinazione canonica uguale.
- File: `src/services/organizer.ts`,
  `tests/unit/services/organizer-safety.test.ts`.
- Dipendenze: nessuna funzionale.
- Cherry-pick: sì, dopo estrazione dei soli file Organizer/test.
- Da rimuovere: modifiche assessment/config non pertinenti.
- Upstream: assente.
- Rischio conflitto: medio, per modifiche successive a `organizer.ts`.
- Stato: PR #100 OPEN, base `develop`, commit `611c6d1d22f75b74edaba5f06d98ef7a24ca6ec3`.

### 2. Organizer optional category directories

- Titolo: `fix(organizer): treat categories as lazy destinations`
- Commit: `a19892c`
- Problema: una categoria assente ma inutilizzata veniva interpretata come
  library non disponibile.
- File: `src/services/organizer.ts`, test Organizer safety.
- Dipendenze: nessuna; possibile conflitto con la PR collision safety.
- Cherry-pick: sì, dopo estrazione.
- Upstream: assente.
- Rischio conflitto: medio/alto con la PR Organizer collision safety.
- Stato: PR #101 OPEN, base `develop`, commit `381d2cd`; indipendente da #100.

### 3. Seerr canonical Settings keys

- Titolo: `fix(settings): persist canonical Seerr configuration keys`
- Commit: `2e6e4c9`
- Problema: UI e schema usavano `OVERSEERR_*` e `SEERR_*` in modo
  incoerente.
- File: Settings UI e `tests/unit/core/configApi.test.ts`.
- Dipendenze: nessuna.
- Cherry-pick: sì.
- Upstream: assente.
- Rischio conflitto: medio con altre modifiche alla Settings page.
- Stato: PR #102 OPEN, base `develop`, commit `2e3b4e2`.

### 4. Seerr URL/API-root normalization

- Titolo: `fix(seerr): normalize service and API root URLs`
- Commit: `784aaa4`
- Problema: duplicazione possibile di `/api/v1` e comportamento diverso tra
  adapter e poller.
- File: `src/services/seerrUrl.ts`, adapter/poller, Settings UI e test.
- Dipendenze: integrazione Seerr esistente; consigliata dopo la PR canonical
  keys.
- Cherry-pick: sì, con possibili conflitti sulla Settings page.
- Upstream: equivalente non identificato.
- Rischio conflitto: medio.
- Stato: PR #103 OPEN, base `develop`, commit `9bfbc55`.

### 5. Settings provenance / persisted dotenv

- Titolo: `fix(settings): distinguish container environment from persisted dotenv`
- Commit: `8e8566a`, con origine funzionale in `e7983ad`.
- Problema: valori persistiti in `.env` venivano classificati come environment
  lockati.
- File: `src/core/configApi.ts` e test config.
- Dipendenze: estrazione delle sole modifiche config dai commit misti.
- Cherry-pick: sì dopo estrazione.
- Upstream: da verificare nuovamente contro HEAD.
- Rischio conflitto: medio/alto con evoluzioni upstream della config API.
- Stato: PR #104 OPEN, base `develop`, commit `45286f0`.

### 6. Docker build context/layer caching

- Titolo: `build: reduce Docker context and preserve dependency layer reuse`
- Commit: `ca2703c`
- Problema: context grande e invalidazione inutile dei layer.
- File: `.dockerignore`, `Dockerfile`.
- Dipendenze: nessuna.
- Cherry-pick: sì, dopo confronto con Dockerfile upstream corrente.
- Upstream: non presente nella merge-base analizzata.
- Rischio conflitto: medio.
- Escludere benchmark locali non riproducibili.
- Stato: PR #105 OPEN, base `develop`, commit `39d6b1b`.

### 7. AllDebrid file-tree migration export

- Titolo: `fix(migration): export provider file-tree media files`
- Commit principale: `9a741ca`; prerequisito storico: `ebe6db8`.
- Problema: manifest con magnet/infohash validi ma `mediaFiles` vuoto per
  ProviderItem AllDebrid.
- File: provider capability, `migrationExporter` e test relativi.
- Dipendenze: MigrationExporter e generic provider capability contract.
- Cherry-pick: non dal solo `9a741ca`; richiede il sottosistema migration.
- Upstream: assente.
- Rischio conflitto: alto se upstream non possiede il capability contract.

### Arr bridge fixes già upstream

`a20b84fa5aeff21afaba1b06cafcf790b162de64` preserva i path relativi nello
staging annidato; `1c6f49479488014cd2989eb9cd9d765aae24236e` persiste e ripristina
i torrent tracciati dopo restart. Entrambi sono già presenti nell'upstream
corrente: nessuna nuova PR necessaria.

### Seerr duplicate request detection

Commit coinvolti: `c3e6ca5`, `9770713`.

Fix generico e separabile per evitare richieste duplicate tramite stato media
e request listing Seerr. Non fa parte del Media Manager MVP; eventuale PR
standalone successiva, dipendente dall'acquisition adapter.

## MEDIA_MANAGER_PRS

Il delta Media Manager è troppo ampio per una singola PR efficace, ma non va
spezzato artificialmente in decine di PR. La serie minima consigliata è:

### 1. Media Manager core e read-only policy engine

Famiglie principali: `97a0041`, `9c415ee`, `272b440`, `29e6112`, `ebe6db8`,
`03db6b4`, `3067092`, `c08c62b`.

Include VersionManager, canonical inventory, metadata/identity evidence,
profili, requirements, scoring, policy hash, Delete Preview read-only,
persistence e API backend.

Dipende dal provider abstraction e dal file-tree/migration model.

### 2. Media Manager UI, identity e unified review

Famiglie principali: `5e54fe0`, `937f563`, `6f5a0d0`, `8dd76b7`, `014d25e`,
`93f2646`, `e1e00b4`.

Include shell/navigazione, Library/Missing/Review/Delete Preview, editor
Profiles/Languages/Rules/Scoring, manual identity/TMDb picker, unified review,
confirmation UX e Settings hash navigation.

Dipende dalla PR core/API.

### 3. Migration/capability/export integration

Famiglie: `c9be39c`, `8c7cfe1`, `43af9b9`, `354f635`, `ae9e9c9`, `3cf5ad2`,
`aabe9f7`, `9a741ca`.

Include MigrationManifest, capability metadata, recoverability, import preview,
audit semantico e file-tree `mediaFiles`. Deve restare read-only per delete e
import reali.

Può essere una PR separata oppure prerequisito della PR core, secondo la
strategia del maintainer.

## FUTURE_PRS

- **FUSE mount readiness / startup precheck** —
  `DEPLOYMENT_VALIDATED / FUTURE_UPSTREAM_PR`. Soluzione generica futura:
  readiness reale FUSE, fail-closed per Organizer e operazioni mount-dependent,
  senza sostituire lo standard backend/runtime. Non includere nella PR Media
  Manager.
- **Simple Policy Presets** — `POST_MVP_UPGRADE`; deve generare lo stesso
  modello canonico dell'Advanced Policy Editor.
- **Organizer filename mode** — verificare prima se l'opzione è desiderata
  upstream; non combinarla automaticamente con collision safety.

## SANITIZATION_REQUIRED

Prima di qualsiasi PR devono essere esclusi o sanitizzati:

- assessment e report locali con provider item, titoli della libreria o dati
  runtime;
- provider ID, infohash, magnet URI, manifest/export reali;
- path `/home/samtruman`, mount CineCircle e configurazioni Docker locali;
- token, API key, password e cookie;
- fixture operative e snapshot/log E2E;
- `validation-runtime` e `validation-runtime/backups`;
- deployment override CineCircle;
- conteggi runtime e policy hash, da mantenere solo come evidence documentale,
  non come business-rule/test target hardcoded;
- numeri request Seerr e TMDb ID reali nei report storici.

Fixture sintetiche, hash fittizi e URL `example` sono pubblicabili dopo
revisione.

## DEPENDENCY_ORDER

1. Verificare nuovamente `upstream/develop` e i conflitti.
2. Estrarre Organizer collision safety da `upstream/develop`.
3. Estrarre Organizer optional category directories da `upstream/develop`.
4. Pubblicare Settings/Seerr fixes: canonical keys, URL normalization,
   provenance.
5. Pubblicare Docker optimization dopo confronto upstream.
6. Separare MigrationExporter/provider file-tree capability.
7. Pubblicare Media Manager core/API.
8. Pubblicare Media Manager UI/identity/unified review.
9. FUSE readiness: PR #106 (`fix/mount-readiness-guard`) is OPEN against
   `develop`, using shared per-source readiness rather than a global startup
   gate.
10. Trattare Simple Policy Presets come upgrade post-MVP.

## RECOMMENDED_FIRST_PR

`fix(organizer): preserve colliding media versions`

È il candidato migliore perché è generico, indipendente dal Media Manager,
testato, privo di credenziali/provider runtime e assente dall'upstream corrente.

## NEW_STANDALONE_PR_CANDIDATE

### Provider Settings canonical keys

- Titolo: `fix(settings): align provider credential keys with backend schema`
- Scope: AllDebrid (`AD_*` → `ALLDEBRID_*`) and Premiumize (`PM_*` →
  `PREMIUMIZE_*`) API/WebDAV settings.
- Problema: la GUI salva chiavi che il backend/provider runtime non legge; le
  chiavi canoniche mancano inoltre dal `CONFIG_SCHEMA`.
- Include: allineamento GUI/schema/runtime e test di persistenza/loading.
- Esclude: credenziali reali, `.env` operativo, deployment e riconciliazione
  AllDebrid specifica del fork.
- Classificazione: `GENERIC_UPSTREAM_FIX`.
- Stato: candidato nuovo, da implementare e isolare prima della pubblicazione.

Questo candidato va mantenuto separato dai fix già pubblicati per Real-Debrid,
Seerr e TMDB: quelli correggono rispettivamente caricamento persistito,
