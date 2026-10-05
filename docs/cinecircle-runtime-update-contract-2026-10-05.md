# Runtime update contract — 2026-10-05

## Why this is required

The production stack does not build the GUI and backend from one checkout:

- the backend TypeScript is mounted from
  `config/validation-runtime/src`;
- the Next.js GUI is mounted as a pre-built `.next` directory;
- the compose image supplies the shared runtime dependencies.

These artifacts can therefore come from different revisions. Replacing
`server.ts` from an older checkout can remove APIs required by the already-built
Media Manager GUI and turn the page into an HTML 404 response.

## Required deployment sequence

Before copying or replacing runtime files:

1. identify the backend source revision and GUI build revision;
2. run `scripts/validate-runtime-contract.sh` against both artifacts;
3. stop if any required `/api/version-manager/*` or organizer route is absent;
4. apply a targeted patch to the matching source revision;
5. run the contract check again;
6. only after explicit approval recreate SchroDrive;
7. verify health plus the contract endpoints before touching any other service.

The contract check is read-only and is intended to prevent accidental
replacement of a newer `server.ts` with an older local copy.

## Current repository limitation

The checked-out source in this repository is older than the production GUI
build. The production runtime source must be imported into the repository (or
the repository must be switched to the matching branch) before implementing
Media Manager review UI changes. Until then, no production source file should
be replaced from this checkout.
