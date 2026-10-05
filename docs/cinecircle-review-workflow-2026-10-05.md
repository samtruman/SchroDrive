# Organizer review workflow — 2026-10-05

## Current behavior

SchröDrive keeps provider media untouched and records unresolved organizer
identity decisions separately. A reliable structured TV identity such as
`S01E02` is no longer sent to review only because the provider directory does
not contain a year. Existing pending entries of that kind are automatically
resolved and retained in the audit trail.

Policy reviews and identity reviews are distinct:

- identity reviews require an explicit title/year/type decision;
- policy reviews indicate that the active profile requirements are not met;
- a policy review must not be confused with the library retention/delete
  workflow.

## Planned review actions

The review UI is scheduled to expose separate actions and filters:

- `Dismiss`: closes the review without changing provider media;
- `Remove from provider`: explicitly removes the provider source after a
  confirmation and a fresh safety check;
- `Resolve identity`: available only for identity issues.

The generic `Delete` label is intentionally avoided in this tab because the
library/retention tab already has a deletion workflow.

## Configuration save behavior

Saving configuration persists the values and reports `restartRequired` to the
GUI. It does not restart the process. Restart remains an explicit action.

## Deployment safety

The deployed GUI and backend must be treated as one compatible snapshot. The
media-manager GUI depends on `/api/version-manager/*`; deploying an older
`server.ts` over the runtime source removes those routes and produces HTML 404
responses in the GUI. Future deployments must therefore validate the GUI API
surface before recreating SchröDrive.
