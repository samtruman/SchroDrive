# SchroDrive deployment

The repository has three independently deployable artifacts:

- the Docker image;
- the backend source mounted through the runtime override;
- the frontend .next directory mounted by the active stack.

A container recreate alone is not sufficient when either mount is stale. Use the
repository deployment pipeline:

    scripts/deploy-schrodrive.sh --check
    scripts/deploy-schrodrive.sh --deploy

The default check mode runs diff validation, backend typecheck and tests, backend
build, and frontend build without changing files, mounts, images, or services.
Deploy mode then creates a timestamped backup, writes BUILD_INFO.json, syncs the
backend and frontend mounts, builds a commit-tagged image, recreates only the
SchroDrive service, and verifies:

- health endpoint;
- API build commit;
- Audit Cleanup endpoint;
- Audit Cleanup frontend route.

The script fails closed if a required path or command is missing. It does not
deploy other stack services. Environment variables can override the compose,
runtime, frontend, backup, API-port, and web-port paths for other deployments.

## Source, build and runtime identity

The current refresh-library milestone is tracked on:

- branch: `pr/non-blocking-mount-status-20261012`;
- source commit: `b256e2d4cd66e030e79046f9698ec19e496158d3`;
- deployed image: `schrodrive:deploy-5b8aeb39797b`.

The branch is pushed to the fork and the working tree is clean. The image was
built from the same validated source contents before the final Git commit was
created, so a subsequent deploy is required if the runtime build label must
report `b256e2d` exactly. Record this distinction instead of assuming that a
successful image build proves source/runtime identity alignment.

The deploy script uses the host Bun installation even for non-interactive SSH
sessions. On the current server it is `/home/samtruman/.bun/bin/bun`; an
explicit `SCHRODRIVE_BUN_BIN` may be supplied when another installation is
required.

## Configuration precedence and Organizer naming

Configuration has two sources:

1. runtime/container environment variables, which take precedence and are
   treated as locked values in the GUI;
2. the persisted `/config/.env` values, used when the runtime value is absent
   or an empty placeholder and exposed as editable settings.

A non-empty runtime value always wins over the persisted value. Saving through
the GUI updates the persisted configuration; it does not silently recreate or
restart the container. Settings that require a new environment value expose a
restart-required state and are applied only after an explicit deploy/container
restart.

Organizer naming and media grouping are separate concerns:

- generated symlinks preserve the original provider release basename;
- `ORGANIZER_GROUP_VERSIONS` controls whether equivalent releases share the
  canonical media folder;
- the version/grouping policy decides which releases belong to the same logical
  media item and does not rename provider files;
- organizer reconciliation may remove obsolete generated symlinks after a
  naming or classification change, but it never modifies provider source files.

## Deployment verification and rollback

The deployment script was validated on the baseline branch with the complete
backend and frontend checks passing. The first real deployment also exposed an
important startup behavior: recreating the container clears the in-memory
WebDAV directory/file-tree cache. A cold start can therefore trigger a full
provider inventory before the backend is responsive.

The deployment was rolled back safely to the previously working image after the
new container remained unhealthy during the AllDebrid full inventory. The
rollback changed only the SchroDrive service. Provider data, application data,
mounts, and the other stack services were not removed or recreated.

The deployment backup contains the previous runtime source, frontend build, and
compose definition. A deployment is considered successful only when the
backend health endpoint, status API, build identity, and relevant frontend
routes respond after startup. A build completing successfully is not by itself
proof that the runtime is ready.

During a cold start the container can remain healthy while the provider
inventory is still being populated. WebDAV `PROPFIND` and rate-limiter log
messages indicate this phase. The dashboard/API may be slow until the first
inventory pass completes; do not recreate unrelated containers in response to
this temporary state.

## Startup inventory and persistent index

The current implementation can perform a full AllDebrid inventory during a
cold start. The directory/file-tree cache is persisted under application data
and restored before the next provider refresh, reducing repeated cold-start
work. A first run or an invalidated cache still fetches provider status and
file trees through the WebDAV bridge, and a provider timeout can delay the
initial inventory.

The planned upstreamable improvement is a persistent, incremental inventory
index:

- persist torrent status and file-tree metadata under the application data
  directory;
- restore the last valid index before contacting the provider;
- make the mount and basic API available immediately;
- refresh new or changed provider items in bounded batches;
- load detailed file trees lazily when requested;
- continue background reconciliation without blocking the HTTP server;
- retain the last valid item-level data when a provider request times out;
- expose inventory progress, errors, retries, and readiness to the API/UI.

The Media Manager must report inventory readiness explicitly. It must not present
partial file-tree data as a complete policy evaluation.

## Mandatory completion checklist

Every substantive development cycle must complete this checklist before it is
considered finished.

1. Start from the canonical checkout and confirm the active branch, remote,
   clean/intentional working tree, and the exact source revision. Do not build
   or deploy from an ad-hoc worktree without recording its commit.
2. Keep the runtime source, backend build, frontend build, container image, and
   deployed build identity aligned. Compare the deployed commit/build identity
   with the source revision after deployment; a successful image build alone is
   not sufficient.
3. Run the relevant Bun tests, the complete applicable unit/regression suite,
   backend typecheck, backend build, frontend build, and git diff --check.
   Use the host Bun installation explicitly for non-interactive sessions
   (SCHRODRIVE_BUN_BIN or /home/samtruman/.bun/bin/bun on the reference host).
4. Update documentation for every new feature, architectural choice, runtime
   contract, configuration behavior, or operational workflow. Small isolated
   bug fixes may use the change description only, but must still record any
   deployment or rollback implication.
5. Before deployment, create the timestamped backup. Use the deployment
   script's check phase first, then its deploy phase. Do not substitute manual
   container/image operations unless the script is being diagnosed and the
   deviation is recorded.
6. After deployment, verify health, API build identity, frontend build identity,
   relevant routes, mount readiness, organizer/reconciliation progress, and
   symlink counts/targets. Confirm that persistence and mounted paths survive a
   restart. Do not declare success while the dashboard is only loading.
7. After a successful cycle, commit the complete intended change, push the
   canonical branch, and compare local HEAD, remote HEAD, image identity, and
   running API identity. Never leave required changes only inside a container
   layer or an uncommitted checkout.

## Upstream pull-request workflow

Upstream contributions use two separate repositories:

- upstream target: moderniselife/SchroDrive;
- PR staging fork: samtruman/SchroDrive-upstream-prs.

For an upstream fix:

1. create a focused branch from the current upstream target base;
2. include only the generic fix, regression tests, and required upstream
   documentation;
3. run the validations listed above;
4. push the branch to samtruman/SchroDrive-upstream-prs;
5. open the PR against moderniselife/SchroDrive and record its number/URL;
6. re-check the PR checks and diff after every push;
7. do not close, reopen, rebase, or force-push an unrelated PR. If an earlier
   PR is unsafe, leave it closed and supersede it with a focused replacement;
8. keep deployment-only changes, local paths, provider credentials, production
   compose files, and CineCircle-specific code out of the upstream branch.

The final handoff must state the source commit, pushed branch, PR number/URL,
tests, typecheck, builds, deployed identity, and any remaining limitation.
