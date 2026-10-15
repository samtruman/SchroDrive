# SchroDrive deployment

The repository produces one deployable application artifact: a complete Docker
image containing the backend, frontend, entrypoint, and runtime dependencies.

The production container must not mount application source, compiled backend
files, or the frontend `.next` directory from the host. Runtime bind mounts are
limited to persistent data and integration paths such as configuration,
database, provider mounts, and download/staging directories. A container
recreate therefore runs exactly the code that was built into the image.

The canonical `docker-compose.yml` uses `SCHRODRIVE_RUNTIME_ROOT` for the
four persistent host paths: `config`, `data`, `mount`, and `downloads`. On
`samserver` its value is `/home/samtruman/docker/cinecircle/schrodrive`.
The runtime root must point to the equivalent existing directory on another
host; never replace it with an old user path or a named volume during a
production recreation.

## Canonical operational checkout

For the SAM server deployment, the canonical operational checkout is always:

    /home/samtruman/projects/schrodrive

All source edits, generated `dist` output, validation, commits, image builds,
and container deployments must be performed from that checkout over SSH on
`samserver` (`x86_64`). A checkout in an agent workstation, temporary
worktree, Raspberry Pi, or validation directory is not a deployment source.
After every release, compare the checkout commit, generated `dist`, image
build identity, and running API/frontend identities before considering the
deployment complete.

The deployment script also refuses to build on another hostname or on a
non-`x86_64` host, and refuses to continue if the runtime `config`, `data`,
`mount`, or `downloads` directory is missing. This prevents accidental
Raspberry Pi builds and incomplete runtime mounts.

Do not use a `validation-runtime` source override, a validation entrypoint, or
an ad-hoc overlay image as a production runtime. Validation tooling may build a
temporary image or inspect a container, but it must be removed or disabled
before the release image is deployed.

Use the repository deployment pipeline:

    scripts/deploy-schrodrive.sh --check
    scripts/deploy-schrodrive.sh --deploy

The default check mode runs diff validation, backend typecheck and tests, backend
build, and frontend build without changing files, mounts, images, or services.
Deploy mode then creates a timestamped backup, builds one complete
commit-tagged image with its embedded BUILD_INFO.json, recreates only the
SchroDrive service, and verifies:

- health endpoint;
- API build commit;
- Audit Cleanup endpoint;
- Audit Cleanup frontend route.

The script fails closed if a required path or command is missing and refuses a
dirty checkout or a compose file containing application-source/build mounts.
It does not deploy other stack services. Environment variables can override
the compose, backup, API-port, and web-port settings for other deployments.
The default post-deploy provider check targets `alldebrid`; set
`SCHRODRIVE_REQUIRED_PROVIDER` when a deployment intentionally uses another
provider. The post-deploy gate verifies the effective runtime, not only the
Compose declaration: backend/runtime/frontend build identities must match the
source commit, the mount service must be active, and the provider directory
must be browseable through `/api/files`. A deployment is failed if any of
these checks fails.

## Source, build and runtime identity

Every release record must name the exact source commit, image tag and image ID,
and the running API build identity. Never keep a historical branch, commit or
image tag here as if it were the current deployment. The image must be built
after the final commit so its embedded BUILD_INFO.json reports that exact SHA.

### Important failure mode: source and `dist` drift

The backend build always regenerates `/app/dist` from `src`. A checkout can
look newer because its generated `dist` directory contains changes that are
not present in the TypeScript source. Building that checkout silently removes
those changes from the image. This previously caused persisted provider
credentials to disappear from the rebuilt runtime: the container started with
an empty provider configuration, the mount appeared empty, and the organizer
treated existing generated symlinks as stale.

Therefore `dist` is never an independent source of truth. Before a build:

1. use the named consolidated checkout, not an ad-hoc worktree or validation
   directory;
2. verify that the source contains every behavior expected from the current
   runtime, especially persisted configuration hydration and mount startup;
3. require a clean working tree, including generated output and lockfiles;
4. build backend and frontend from that same commit;
5. inspect the image before replacement and confirm the compiled artifact
   contains the persisted-config and mount paths;
6. only then recreate SchroDrive and verify the provider mount before allowing
   organizer reconciliation to run.

If the source and generated output disagree, deployment must stop. Do not fix
the mismatch by copying `dist` files manually; consolidate the missing source
changes, commit them, and rebuild the complete image.

The `cloudLinksPreWarm` health field refers only to HTTP cloud-link adapters.
When no HTTP adapter is configured, the pre-warm phase is considered complete
immediately because there is no HTTP directory tree to prefetch. AllDebrid's
WebDAV bridge maintains its torrent-list fallback in persistent application
data, while file details and short-lived download URLs are rebuilt lazily
after a restart.

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

## Canonical runtime alignment procedure

Use this procedure whenever the running container may have been assembled from
an old image, a validation checkout, or a host-mounted build.

### 1. Freeze and inventory

Record the current container image, image ID, entrypoint, command, mounts,
environment, running build identity, and health status. Save a timestamped
backup of persistent application data and the active compose definition. Do not
remove the old image or data before the replacement has passed verification.

The following runtime red flags must be absent from the release container:

- `/config/validation-runtime/src` as application source;
- a validation entrypoint replacing `/docker-entrypoint.sh`;
- `/app/dist` or `/app/web/.next` mounted from the host;
- an image assembled by copying selected files over an unrelated base image.

### 2. Consolidate the source

Start from the canonical checkout and a named branch. Reconcile all intended
changes there, including backend, frontend, tests, deployment scripts, and
documentation. Keep local configuration, credentials, production compose files,
and temporary validation artifacts out of the repository.

The working tree must be clean after the intended commit. Record the branch,
commit SHA, dependency lockfile state, and all test/typecheck/build results.

### 3. Build one complete image

Build the image from the canonical commit using the repository Dockerfile. The
Dockerfile must compile and copy the backend into `/app/dist`, build and copy
the frontend into `/app/web`, and install the standard `/docker-entrypoint.sh`.
Do not copy individual runtime files from another image and do not bind-mount
build output into the container.

Tag the image with the source SHA or an equivalent immutable build identifier,
and expose that identifier through the health/status API and GUI.

### 4. Validate before replacement

Create a temporary container from the new complete image with the required data
and provider mounts, but without production traffic. Verify that PID 1 is
`/docker-entrypoint.sh`, the backend runs `/app/dist/index.js`, the frontend is
served from the image’s `/app/web` tree, and no `/config/validation-runtime`
source is referenced. Also verify health, status API, frontend, provider mount,
organizer, symlinks, SQLite/config readability, and source/image identity.

### 5. Deploy and verify

After backup and preflight checks pass, recreate only the application service
using the complete image and standard entrypoint. Do not manually edit files
inside the container. Repeat the health, API, GUI, mount, organizer, symlink,
persistence, and source-mount checks after startup.

Keep the previous image and backup until startup inventory and the relevant
API/UI workflows have been tested.

### 6. Close the release

Commit the documentation and deployment changes, push the canonical branch,
and compare local HEAD, remote HEAD, image label, running image ID, and API
build identity. A release is not complete while required code exists only in a
container layer, validation directory, uncommitted worktree, or host-mounted
build directory.
