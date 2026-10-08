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
