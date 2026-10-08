#!/usr/bin/env bash
set -Eeuo pipefail

# SchroDrive deployment pipeline.
# Default mode is validation only. Use --deploy to sync runtime/frontend mounts
# and recreate only the SchroDrive service.
MODE="check"
if [[ "${1:-}" == "--deploy" ]]; then MODE="deploy"; fi
if [[ "${1:-}" != "" && "${1:-}" != "--deploy" && "${1:-}" != "--check" ]]; then
  echo "usage: $0 [--check|--deploy]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${SCHRODRIVE_COMPOSE_FILE:-/home/samtruman/docker/cinecircle/compose-active.yml}"
RUNTIME_ROOT="${SCHRODRIVE_RUNTIME_ROOT:-/home/samtruman/docker/cinecircle/schrodrive/config/validation-runtime}"
FRONTEND_ROOT="${SCHRODRIVE_FRONTEND_ROOT:-/home/samtruman/schrodrive-web-next}"
BACKUP_ROOT="${SCHRODRIVE_BACKUP_ROOT:-/home/samtruman/docker/cinecircle/consolidation-backups}"
API_PORT="${SCHRODRIVE_API_PORT:-8970}"
WEB_PORT="${SCHRODRIVE_WEB_PORT:-8971}"
SHORT_SHA="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
FULL_SHA="$(git -C "$ROOT" rev-parse HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
IMAGE="schrodrive:deploy-${SHORT_SHA}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }
}
for command in git docker curl python3 rsync; do require_command "$command"; done
BUN="${SCHRODRIVE_BUN_BIN:-$(command -v bun || true)}"
[[ -x "$BUN" ]] || BUN="/home/samtruman/.bun/bin/bun"
[[ -x "$BUN" ]] || { echo "missing Bun executable; set SCHRODRIVE_BUN_BIN" >&2; exit 1; }
[[ -f "$COMPOSE_FILE" ]] || { echo "compose file not found: $COMPOSE_FILE" >&2; exit 1; }
[[ -d "$RUNTIME_ROOT" ]] || { echo "runtime root not found: $RUNTIME_ROOT" >&2; exit 1; }
[[ -d "$FRONTEND_ROOT" ]] || { echo "frontend mount not found: $FRONTEND_ROOT" >&2; exit 1; }

echo "== SchroDrive deployment validation =="
echo "checkout: $FULL_SHA"
echo "image:    $IMAGE"
echo "mode:     $MODE"

git -C "$ROOT" diff --check
(cd "$ROOT" && "$BUN" run typecheck)
(cd "$ROOT" && "$BUN" test tests/unit tests/e2e tests/regressions)
(cd "$ROOT" && "$BUN" run build)
(cd "$ROOT/web" && "$BUN" run build)

if [[ "$MODE" == "check" ]]; then
  echo "Validation passed. No files, mounts, image, or containers were changed."
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/deploy-$STAMP-$SHORT_SHA"
mkdir -p "$BACKUP"
cp -a "$RUNTIME_ROOT" "$BACKUP/runtime"
cp -a "$FRONTEND_ROOT" "$BACKUP/frontend"
cp -a "$COMPOSE_FILE" "$BACKUP/compose-active.yml"

python3 - "$RUNTIME_ROOT/BUILD_INFO.json" "$FULL_SHA" "$BUILD_TIME" "$IMAGE" <<'PY'
import json
import sys
from pathlib import Path
target, commit, built_at, image = sys.argv[1:]
Path(target).write_text(json.dumps({
    "commit": commit,
    "builtAt": built_at,
    "image": image,
    "runtimeCommit": commit,
    "frontendCommit": commit,
}, indent=2) + "\n")
PY

rsync -a --delete "$ROOT/src/" "$RUNTIME_ROOT/src/"
rsync -a --delete "$ROOT/web/.next/" "$FRONTEND_ROOT/"

docker build -t "$IMAGE" "$ROOT"
OVERRIDE="$(mktemp)"
trap 'rm -f "$OVERRIDE"' EXIT
cat > "$OVERRIDE" <<EOF
services:
  schrodrive:
    image: $IMAGE
EOF

docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE" up -d --force-recreate schrodrive

for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null; then break; fi
  [[ "$attempt" -eq 30 ]] && { echo "healthcheck timeout; backup: $BACKUP" >&2; exit 1; }
  sleep 2
done

python3 - "http://127.0.0.1:$API_PORT/api/status" "$FULL_SHA" <<'PY'
import json
import sys
import urllib.request
url, expected = sys.argv[1:]
data = json.load(urllib.request.urlopen(url, timeout=10))
actual = (data.get("build") or {}).get("commit")
if actual != expected:
    raise SystemExit(f"deployed build mismatch: expected {expected}, got {actual}")
PY
curl -fsS "http://127.0.0.1:$API_PORT/api/organizer/audit-cleanup" >/dev/null
curl -fsS "http://127.0.0.1:$WEB_PORT/media-manager/audit-cleanup" | grep -q "Audit Cleanup"

echo "Deploy passed."
echo "build:  $FULL_SHA"
echo "image:  $IMAGE"
echo "backup: $BACKUP"
