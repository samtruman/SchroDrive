#!/usr/bin/env bash
set -Eeuo pipefail

# SchroDrive deployment pipeline.
# Default mode is validation only. Use --deploy to build one complete image
# and recreate only the SchroDrive service.
MODE="check"
if [[ "${1:-}" == "--deploy" ]]; then MODE="deploy"; fi
if [[ "${1:-}" != "" && "${1:-}" != "--deploy" && "${1:-}" != "--check" ]]; then
  echo "usage: $0 [--check|--deploy]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_COMPOSE_FILE="/home/samtruman/docker/cinecircle/compose-active.yml"
COMPOSE_FILE="${SCHRODRIVE_COMPOSE_FILE:-$RUNTIME_COMPOSE_FILE}"
BACKUP_ROOT="${SCHRODRIVE_BACKUP_ROOT:-$ROOT/.deploy-backups}"
EXPECTED_HOSTNAME="${SCHRODRIVE_DEPLOY_HOSTNAME:-samserver}"
EXPECTED_ARCH="${SCHRODRIVE_DEPLOY_ARCH:-x86_64}"
RUNTIME_ROOT="${SCHRODRIVE_RUNTIME_ROOT:-/home/samtruman/docker/cinecircle/schrodrive}"
API_PORT="${SCHRODRIVE_API_PORT:-8970}"
WEB_PORT="${SCHRODRIVE_WEB_PORT:-8971}"
REQUIRED_PROVIDER="${SCHRODRIVE_REQUIRED_PROVIDER:-alldebrid}"
CURL_CONNECT_TIMEOUT="${SCHRODRIVE_CURL_CONNECT_TIMEOUT:-2}"
CURL_MAX_TIME="${SCHRODRIVE_CURL_MAX_TIME:-8}"
STARTUP_ATTEMPTS="${SCHRODRIVE_STARTUP_ATTEMPTS:-30}"
STARTUP_DELAY="${SCHRODRIVE_STARTUP_DELAY:-2}"
STARTUP_TIMEOUT="${SCHRODRIVE_STARTUP_TIMEOUT:-180}"
SHORT_SHA="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
FULL_SHA="$(git -C "$ROOT" rev-parse HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
IMAGE="schrodrive:deploy-${SHORT_SHA}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }
}
for command in git docker curl python3; do require_command "$command"; done
BUN="${SCHRODRIVE_BUN_BIN:-$(command -v bun || true)}"
[[ -x "$BUN" ]] || BUN="/home/samtruman/.bun/bin/bun"
[[ -x "$BUN" ]] || { echo "missing Bun executable; set SCHRODRIVE_BUN_BIN" >&2; exit 1; }
[[ -f "$COMPOSE_FILE" ]] || { echo "compose file not found: $COMPOSE_FILE" >&2; exit 1; }
actual_hostname="$(hostname -s)"
actual_arch="$(uname -m)"
if [[ "$actual_hostname" != "$EXPECTED_HOSTNAME" ]]; then
  echo "refusing deployment from host $actual_hostname; run this on $EXPECTED_HOSTNAME" >&2
  exit 1
fi
if [[ "$actual_arch" != "$EXPECTED_ARCH" ]]; then
  echo "refusing deployment from architecture $actual_arch; expected $EXPECTED_ARCH" >&2
  exit 1
fi
for runtime_dir in config data mount downloads; do
  [[ -d "$RUNTIME_ROOT/$runtime_dir" ]] || {
    echo "runtime directory is missing: $RUNTIME_ROOT/$runtime_dir" >&2
    exit 1
  }
done
if grep -qE 'validation-runtime|/app/web/\.next|/app/dist' "$COMPOSE_FILE"; then
  echo "compose contains forbidden application source/build override" >&2
  echo "remove validation-runtime and host build mounts before deploying" >&2
  exit 1
fi

echo "== SchroDrive deployment validation =="
echo "checkout: $FULL_SHA"
echo "image:    $IMAGE"
echo "mode:     $MODE"

git -C "$ROOT" diff --check
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "checkout is not clean; commit or intentionally discard changes before deployment" >&2
  git -C "$ROOT" status --short >&2
  exit 1
fi
(cd "$ROOT" && "$BUN" run typecheck)
(cd "$ROOT" && "$BUN" test --path-ignore-patterns=archive/** tests/unit tests/e2e tests/regressions)
(cd "$ROOT" && "$BUN" run build)
(cd "$ROOT/web" && "$BUN" run build)

if [[ "$MODE" == "check" ]]; then
  echo "Validation passed. No files, mounts, image, or containers were changed."
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/deploy-$STAMP-$SHORT_SHA"
mkdir -p "$BACKUP"
cp -a "$COMPOSE_FILE" "$BACKUP/compose-active.yml"

docker build   --build-arg SCHRODRIVE_BUILD_COMMIT="$FULL_SHA"   --build-arg SCHRODRIVE_BUILD_TIME="$BUILD_TIME"   --build-arg SCHRODRIVE_IMAGE="$IMAGE"   -t "$IMAGE" "$ROOT"
OVERRIDE="$(mktemp)"
trap 'rm -f "$OVERRIDE"' EXIT
cat > "$OVERRIDE" <<EOF
services:
  schrodrive:
    image: $IMAGE
EOF

# The production container may have been created by the historical CineCircle
# compose project rather than by this checkout.  Compose cannot replace a
# same-named container owned by another project, so fail-safe replacement must
# be explicit and limited to this exact service container.  Do not touch any
# dependency containers or volumes.
if docker inspect schrodrive >/dev/null 2>&1; then
  existing_image="$(docker inspect --format '{{.Config.Image}}' schrodrive)"
  existing_service="$(docker inspect --format '{{index .Config.Labels \"com.docker.compose.service\"}}' schrodrive 2>/dev/null || true)"
  if [[ "$existing_service" == "schrodrive" || "$existing_image" == schrodrive:* || "$existing_image" == ghcr.io/moderniselife/schrodrive:* ]]; then
    echo "Replacing existing SchroDrive container: image=$existing_image"
    docker rm -f schrodrive >/dev/null
  else
    echo "refusing to replace unrelated container named schrodrive: image=$existing_image service=$existing_service" >&2
    exit 1
  fi
fi

# The compose file declares other stack services as dependencies.  The
# release pipeline owns only SchroDrive; recreating or creating Prowlarr,
# Seerr, and the other integrations here can conflict with their independently
# managed containers.  Keep the replacement scoped to this service.
docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE" up -d --no-deps --force-recreate schrodrive

probe() {
  curl -fsS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" "$1" >/dev/null
}

deadline=$((SECONDS + STARTUP_TIMEOUT))
while (( SECONDS < deadline )); do
  state="$(docker inspect --format '{{.State.Status}}' schrodrive 2>/dev/null || true)"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' schrodrive 2>/dev/null || true)"
  if [[ "$state" == "running" && ( "$health" == "healthy" || "$health" == "none" ) ]]; then
    break
  fi
  if [[ "$state" == "exited" || "$state" == "dead" ]]; then
    echo "container entered $state during startup; backup: $BACKUP" >&2
    docker compose -f "$COMPOSE_FILE" ps schrodrive >&2 || true
    docker logs --tail 120 schrodrive >&2 || true
    exit 1
  fi
  sleep "$STARTUP_DELAY"
done

if (( SECONDS >= deadline )); then
  echo "container health timeout after ${STARTUP_TIMEOUT}s; backup: $BACKUP" >&2
  docker compose -f "$COMPOSE_FILE" ps schrodrive >&2 || true
  docker logs --tail 120 schrodrive >&2 || true
  exit 1
fi

status_check=0
python3 - "http://127.0.0.1:$API_PORT/api/status" "$FULL_SHA" "$CURL_MAX_TIME" <<'PY' || status_check=$?
import json
import sys
import urllib.request
url, expected, timeout = sys.argv[1:]
try:
    data = json.load(urllib.request.urlopen(url, timeout=float(timeout)))
except Exception as exc:
    print(f"API status unavailable during startup scan: {exc}", file=sys.stderr)
    raise SystemExit(2)
actual = (data.get("build") or {}).get("commit")
if actual != expected:
    raise SystemExit(f"deployed build mismatch: expected {expected}, got {actual}")
PY
if [[ "$status_check" -eq 2 ]]; then
  echo "warning: API status is still busy; BUILD_INFO and container health checks passed" >&2
elif [[ "$status_check" -ne 0 ]]; then
  echo "deployed build identity check failed; backup: $BACKUP" >&2
  exit 1
fi
audit_api="http://127.0.0.1:$API_PORT/api/organizer/audit-cleanup"
if ! audit_payload="$(curl -fsS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" "$audit_api")"; then
  echo "audit-cleanup API check failed: $audit_api" >&2
  exit 1
fi
python3 - "$audit_payload" <<'PY'
import json
import sys
try:
    payload = json.loads(sys.argv[1])
except Exception as exc:
    raise SystemExit(f"audit-cleanup API did not return JSON: {exc}")
if payload.get("ok") is not True or not isinstance(payload.get("audit"), dict):
    raise SystemExit("audit-cleanup API returned an invalid payload")
PY

# A healthy container is not enough: verify the effective runtime provider and
# mount. This catches Compose/runtime drift that leaves a stale FUSE endpoint.
runtime_mounts="$(docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' schrodrive 2>/dev/null || true)"
if grep -qE '^/(config/validation-runtime|app/(dist|web)(/|$))' <<<"$runtime_mounts"; then
  echo "runtime contains a forbidden source/build override:" >&2
  echo "$runtime_mounts" >&2
  exit 1
fi

status_payload="$(curl -fsS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" "http://127.0.0.1:$API_PORT/api/status")"
python3 - "$status_payload" "$FULL_SHA" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
expected = sys.argv[2]
build = payload.get("build") or {}
if any(build.get(key) != expected for key in ("commit", "runtimeCommit", "frontendCommit")):
    raise SystemExit(f"runtime build identity mismatch: expected {expected}, got {build}")
if (payload.get("services") or {}).get("mount") is not True:
    raise SystemExit("runtime mount service is not active")
PY

provider_path="/$REQUIRED_PROVIDER"
encoded_provider_path="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$provider_path")"
provider_payload="$(curl -fsS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
  "http://127.0.0.1:$API_PORT/api/files?path=$encoded_provider_path")"
python3 - "$provider_payload" "$REQUIRED_PROVIDER" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
provider = sys.argv[2]
if payload.get("ok") is not True or payload.get("type") != "directory":
    raise SystemExit(f"provider mount is not browseable: {provider}: {payload}")
PY

frontend_build="$(curl -fsS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
  "http://127.0.0.1:$WEB_PORT/api/build")"
python3 - "$frontend_build" "$FULL_SHA" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
expected = sys.argv[2]
for key in ("commit", "runtimeCommit", "frontendCommit"):
    if payload.get(key) != expected:
        raise SystemExit(f"frontend build identity mismatch for {key}: expected {expected}, got {payload}")
PY

if ! curl -fsS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
  "http://127.0.0.1:$WEB_PORT/media-manager/audit-cleanup" | grep -q "Audit Cleanup"; then
  echo "audit-cleanup GUI route check failed" >&2
  exit 1
fi

echo "Deploy passed."
echo "build:  $FULL_SHA"
echo "image:  $IMAGE"
echo "backup: $BACKUP"
