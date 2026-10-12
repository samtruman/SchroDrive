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

## Current repository status

The checkout used for the current runtime work is
`/home/samtruman/projects/schrodrive`, on branch
`pr/non-blocking-mount-status-20261012`. Its current work is committed and
pushed at `b256e2d4cd66e030e79046f9698ec19e496158d3`.

The contract remains required because a runtime image can still be older than a
new source commit until the deployment script is run. Do not infer alignment
from a healthy container alone: compare source commit, frontend build commit,
image tag and runtime build endpoint after every deploy.
