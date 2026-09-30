# Media Manager UX Acceptance

## Scope

This acceptance run used an isolated SchröDrive runtime with temporary data
and an explicit ARR discovery fixture. No provider, Seerr, acquisition, scan,
delete, or migration mutation was performed.

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
- Provider mutations: none.
