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
IMAGE_RETENTION="${SCHRODRIVE_IMAGE_RETENTION:-2}"
MIN_FREE_KIB="${SCHRODRIVE_MIN_FREE_KIB:-12582912}"
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
free_kib="$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')"
if ! [[ "$free_kib" =~ ^[0-9]+$ ]] || (( free_kib < MIN_FREE_KIB )); then
  echo "insufficient free space for a safe build: ${free_kib:-unknown} KiB available, ${MIN_FREE_KIB} KiB required" >&2
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
for required_tool in ffmpeg ffprobe rclone; do
  docker run --rm --entrypoint /bin/sh "$IMAGE" -lc "command -v $required_tool >/dev/null" || {
    echo "built image is missing required runtime tool: $required_tool" >&2
    exit 1
  }
done

previous_image="$(docker inspect --format '{{.Config.Image}}' schrodrive 2>/dev/null || true)"
rollback_required=0
rollback() {
  exit_code=$?
  if (( rollback_required == 1 )); then
    echo "deployment failed; restoring compose source and previous SchroDrive image" >&2
    cp -a "$BACKUP/compose-active.yml" "$COMPOSE_FILE"
    docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate schrodrive >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap rollback ERR

python3 - "$COMPOSE_FILE" "$IMAGE" <<'PY'
import os
import re
import sys
import tempfile

path, image = sys.argv[1:]
text = open(path, encoding="utf-8").read()
pattern = re.compile(r"(?ms)^(\s{2}schrodrive:\s*\n)(.*?)(?=^\s{2}[A-Za-z0-9_.-]+:\s*\n|\Z)")
match = pattern.search(text)
if not match:
    raise SystemExit("compose service schrodrive was not found")
body = match.group(2)
if re.search(r"(?m)^\s{4}image:\s*", body):
    body = re.sub(r"(?m)^\s{4}image:\s*.*$", f"    image: {image}", body, count=1)
else:
    body = f"    image: {image}\n" + body
updated = text[:match.start()] + match.group(1) + body + text[match.end():]
fd, temporary = tempfile.mkstemp(prefix=".compose-active.", dir=os.path.dirname(path), text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(updated)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
rollback_required=1

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
docker compose -f "$COMPOSE_FILE" config >/dev/null
docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate schrodrive

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

effective_image="$(docker inspect --format '{{.Config.Image}}' schrodrive)"
if [[ "$effective_image" != "$IMAGE" ]]; then
  echo "runtime image mismatch: expected $IMAGE, got $effective_image" >&2
  exit 1
fi
compose_image="$(docker compose -f "$COMPOSE_FILE" config | awk '/^[[:space:]]+schrodrive:/{service=1; next} service && /^[[:space:]]+image:/{print $2; exit} service && /^[[:space:]]{2}[A-Za-z0-9_.-]+:/{exit}')"
if [[ "$compose_image" != "$IMAGE" ]]; then
  echo "compose source image mismatch: expected $IMAGE, got ${compose_image:-missing}" >&2
  exit 1
fi

if ! curl -fsS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
  "http://127.0.0.1:$WEB_PORT/media-manager/audit-cleanup" | grep -q "Audit Cleanup"; then
  echo "audit-cleanup GUI route check failed" >&2
  exit 1
fi

# Keep the active image and one previous deploy image for rollback.  Without
# this retention step every deploy leaves a full tagged image behind and the
# Docker filesystem eventually fills up.  This runs only after every health,
# build-identity, mount and GUI check has passed.
if ! [[ "$IMAGE_RETENTION" =~ ^[2-9][0-9]*$ ]]; then
  echo "SCHRODRIVE_IMAGE_RETENTION must be an integer >= 2" >&2
  exit 1
fi
mapfile -t deploy_images < <(docker image ls --filter 'reference=schrodrive:deploy-*' --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' | sort -rk2,3 | awk '{print $1}')
keep_images=("$IMAGE")
if [[ -n "$previous_image" && "$previous_image" == schrodrive:deploy-* && "$previous_image" != "$IMAGE" ]]; then
  keep_images+=("$previous_image")
fi
for candidate in "${deploy_images[@]}"; do
  (( ${#keep_images[@]} >= IMAGE_RETENTION )) && break
  [[ " ${keep_images[*]} " == *" $candidate "* ]] || keep_images+=("$candidate")
done
if (( ${#deploy_images[@]} > ${#keep_images[@]} )); then
  echo "Pruning ${#deploy_images[@]} SchroDrive deploy images to retention=$IMAGE_RETENTION"
  for obsolete_image in "${deploy_images[@]}"; do
    [[ " ${keep_images[*]} " == *" $obsolete_image "* ]] && continue
    docker image rm "$obsolete_image" || echo "warning: unable to remove $obsolete_image" >&2
  done
fi

rollback_required=0
trap - ERR

echo "Deploy passed."
echo "build:  $FULL_SHA"
echo "image:  $IMAGE"
echo "backup: $BACKUP"
