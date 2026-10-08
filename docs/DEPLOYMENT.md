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

## Startup inventory and persistent index

The current implementation can perform a full AllDebrid inventory during a
cold start. This is a known operational limitation: provider status and file
trees are fetched through the WebDAV bridge, and a single provider timeout can
delay the initial inventory.

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
