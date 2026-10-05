#!/usr/bin/env bash
set -euo pipefail

# Validates a backend source tree against the API contract required by the
# already-built Media Manager GUI. This is intentionally read-only.
#
# Usage:
#   validate-runtime-contract.sh <backend-src> <gui-build-dir>

backend_src=${1:?backend source directory is required}
gui_build=${2:?GUI build directory is required}
contract_file=${CONTRACT_FILE:-"$(dirname "$0")/../deploy/media-manager-api-contract.txt"}

if [[ ! -d "$backend_src" ]]; then
  echo "backend source directory does not exist: $backend_src" >&2
  exit 2
fi
if [[ ! -d "$gui_build" ]]; then
  echo "GUI build directory does not exist: $gui_build" >&2
  exit 2
fi
if [[ ! -f "$contract_file" ]]; then
  echo "API contract file does not exist: $contract_file" >&2
  exit 2
fi

if ! find "$gui_build" -type f \( -name '*.js' -o -name '*.html' -o -name '*.rsc' \) -print -quit | grep -q .; then
  echo "GUI build contains no inspectable Next.js artifacts: $gui_build" >&2
  exit 1
fi

missing=0
while IFS= read -r route; do
  [[ -z "$route" || "$route" == \#* ]] && continue
  if ! grep -RIlF --include='*.ts' --include='*.tsx' --include='*.js' -- "$route" "$backend_src" | grep -q .; then
    echo "MISSING backend route: $route" >&2
    missing=1
  fi
done < "$contract_file"

if [[ "$missing" -ne 0 ]]; then
  echo "Runtime contract validation failed; deployment must stop." >&2
  exit 1
fi

echo "Runtime contract OK: GUI build and backend source expose the required Media Manager API."
