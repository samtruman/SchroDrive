# Media Manager UX Acceptance

## Scope

This acceptance run covered both the deployed UI and an isolated SchröDrive
runtime. The isolated run used temporary data and an explicit ARR discovery
fixture. No provider, acquisition, scan, delete, or migration mutation was
performed.

## Remediation gate — final deployed runtime

The remediation runtime was deployed only to `schrodrive` from commit
`c8d27be` and image digest `sha256:4c6f1a6a09d26e921e018818847aa8c218906e8fae9cf9a2776e21da33c13698`.
The browser runner used Chromium from the isolated Playwright container.

| Requirement | Runtime assertion | Visual evidence | Result |
|---|---|---|---|
| Content identity | `1917` is the primary title; the release name is subordinate to its version row | `artifacts/media-manager-ux-live/library-after.png` | PASS |
| Compact Library | informative compact version rows and no opaque ProviderItem title | `artifacts/media-manager-ux-live/library-after.png` | PASS |
| Version details | clicking the version opens `Content Detail` with identity, version, physical and policy sections | `artifacts/media-manager-ux-live/version-details-after.png` | PASS |
| Multiversion grouping | Alien Romulus is one content row with two version rows | `artifacts/media-manager-ux-live/library-after.png` | PASS |
| Review explanation | Details opens a real panel with problem, confidence, source, versions and policy context | `artifacts/media-manager-ux-live/review-comparison-after.png` | PASS |
| Delete decision explanation | cards show content, candidate/kept interpretation, reason and physical status | `artifacts/media-manager-ux-live/delete-dry-run-after.png` | PASS |
| Shared-resource protection | protected physical resource explains why it cannot be deleted; ProviderItem is technical detail | `artifacts/media-manager-ux-live/protected-provider-item-after.png` | PASS |
| Migration workflow | Migration Preview, guarded Execute Migration, confirmation and completed fixture report | `artifacts/media-manager-ux-live/migration-completed.png` | PASS |

The final Playwright run recorded no console errors or failed network requests.
The migration execution assertion used only intercepted synthetic APIs and a
synthetic manifest; no provider or production mutation was performed.

## ARR settings journey

| Step | Result | Evidence |
|---|---|---|
| Acquisition Mode is first | PASS | Playwright screenshot |
| ARR mode hides manual Profiles, Scoring, Languages, Rules | PASS | Playwright assertion |
| Four ARR mappings are visible | PASS | Playwright assertion |
| Unsaved changes indicator | PASS | Playwright assertion and screenshot |
| Save ARR Configuration | PASS | `PUT /api/version-manager/profiles` through Web proxy |
| Navigate away and reload | PASS | Values remained identical |
| ARR to Native and back | PASS | Manual editors appeared/disappeared; mappings remained |
| Persistence after isolated container restart | PASS | Backend status read after restart |

## Deployed UI journey

| User journey | Expected | Actual | Result | Evidence |
|---|---|---|---|---|
| ARR Settings | Acquisition Mode first; manual editors hidden; four real mappings | 4 profiles available: 2 Radarr and 2 Sonarr; all assertions passed | PASS | `artifacts/media-manager-ux-live/live-arr-initial.png` |
| ARR mapping save | Select all four, save, receive confirmation | Saved Radarr 2160p, Sonarr 2160p, Radarr 1080p, Sonarr 1080p; `Saved` shown | PASS | `artifacts/media-manager-ux-live/live-arr-unsaved-real.png` |
| Navigation and refresh | Values survive navigation and reload | All four values persisted identically | PASS | `artifacts/media-manager-ux-live/live-arr-real-persisted.png` |
| ARR → Native → ARR | Manual editors appear; ARR mappings survive | Manual editors appeared; mappings remained; original live values restored | PASS | `artifacts/media-manager-ux-live/live-native.png` |
| Library | Page loads without implicit scan | Page loaded; no failed requests | PASS | `artifacts/media-manager-ux-live/live-library.png` |
| Overview / Missing / Review / Delete | Routes are navigable and show their states | All four routes loaded; Delete remained dry-run | PASS | Related `artifacts/media-manager-ux-live/live-*.png` screenshots |

The deployed configuration initially had all four mappings empty. The live
browser test temporarily selected the real profiles, verified persistence,
then restored the original empty mapping state. No provider configuration or
provider data was changed.

The live run recorded zero console errors, failed network requests, or HTTP
5xx responses. The API returned four real profiles (two Radarr and two
Sonarr, with source `seerr`/`arr-fallback`).

The first browser run exposed a real defect: the Web proxy had no
`PUT /api/version-manager/profiles` route and returned Next.js 404 HTML. The
route was added and the journey passed on the rebuilt image.

Expected 503 responses from Review/Preview in the empty isolated fixture were
not classified as UI failures; those endpoints correctly reported that no
valid inventory snapshot existed.

## Artifacts

Screenshots were produced by the temporary Playwright runner for:

- ARR initial state;
- ARR unsaved state;
- ARR persisted state;
- Native mode.

## Validation

- Full suite: 263 pass, 0 fail.
- Typecheck: pass.
- Backend build: pass.
- Web build: pass.
- Browser acceptance: pass in isolated fixture runtime.
- Browser acceptance: pass on the deployed UI; temporary settings were restored.
- Provider mutations: none.
