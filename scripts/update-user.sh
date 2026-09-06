#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
app_dir=$(cd -- "$script_dir/.." && pwd -P)
app_parent=$(dirname -- "$app_dir")

usage() {
  cat <<'EOF'
Usage:
  bash scripts/update-user.sh                 Update a clean Git checkout
  bash scripts/update-user.sh --zip FILE.zip  Atomically update a ZIP installation
  bash scripts/update-user.sh --health-port   Print the configured local health-check port
EOF
}

prune_old_backups() {
  local keep=3 index candidate
  local -a backups=()
  mapfile -t backups < <(
    find "$app_parent" -mindepth 1 -maxdepth 1 -type d -name '.codex-pwa-backup-*' -printf '%T@ %p\n' \
      | sort -rn | cut -d' ' -f2-
  )
  for ((index = keep; index < ${#backups[@]}; index += 1)); do
    candidate=${backups[index]}
    if [[ "$(dirname -- "$candidate")" == "$app_parent" && "$(basename -- "$candidate")" == .codex-pwa-backup-* ]]; then
      rm -rf -- "$candidate"
    fi
  done
}

resolve_health_port() {
  local env_file port unit_environment
  env_file="${XDG_CONFIG_HOME:-$HOME/.config}/codex-pwa/codex-pwa.env"
  port=""
  if [[ -f "$env_file" ]]; then
    port=$(sed -n 's/^CODEX_PWA_PORT="\{0,1\}\([0-9][0-9]*\)"\{0,1\}$/\1/p' "$env_file" | head -1 || true)
  fi
  if [[ -z "$port" ]]; then
    unit_environment=$(systemctl --user show codex-pwa.service --property=Environment --value 2>/dev/null || true)
    port=$(node -e '
      const match = /(?:^|\s)CODEX_PWA_PORT=(?:"|'"'"')?(\d{1,5})(?:"|'"'"')?(?:\s|$)/u.exec(process.argv[1] || "");
      if (match) process.stdout.write(match[1]);
    ' "$unit_environment" || true)
  fi
  if [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1 && port <= 65535)); then
    printf '%s\n' "$port"
    return 0
  fi
  return 1
}

if [[ "${1:-}" == "--health-port" ]]; then
  [[ $# -eq 1 ]] || { usage >&2; exit 2; }
  resolve_health_port
  exit $?
fi

if [[ "${1:-}" == "--zip" ]]; then
  archive=${2:?missing ZIP archive path}
  [[ $# -eq 2 ]] || { usage >&2; exit 2; }
  archive=$(realpath -- "$archive")
  [[ -f "$archive" ]] || { printf 'ZIP archive was not found: %s\n' "$archive" >&2; exit 2; }
  command -v unzip >/dev/null 2>&1 || { printf 'unzip is required for ZIP updates.\n' >&2; exit 1; }

  stage=$(mktemp -d "$app_parent/.codex-pwa-update.XXXXXX")
  cleanup_stage=1
  trap 'if [[ "${cleanup_stage:-0}" == "1" ]]; then rm -rf -- "$stage"; fi' EXIT
  unzip -q "$archive" -d "$stage"
  mapfile -t candidates < <(find "$stage" -mindepth 1 -maxdepth 1 -type d -name 'codex-pwa-v*' -print)
  if [[ ${#candidates[@]} -ne 1 || ! -f "${candidates[0]}/package.json" ]]; then
    printf 'The archive must contain exactly one codex-pwa-v*/ package root.\n' >&2
    exit 1
  fi
  candidate=${candidates[0]}
  printf 'Preparing and testing candidate %s...\n' "$(node -p 'require(process.argv[1]).version' "$candidate/package.json")"
  (
    cd -- "$candidate"
    npm ci --omit=dev
    npm run check
  )

  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup="$app_parent/.codex-pwa-backup-$stamp"
  failed="$app_parent/.codex-pwa-failed-$stamp"
  mv -- "$app_dir" "$backup"
  if ! mv -- "$candidate" "$app_dir"; then
    mv -- "$backup" "$app_dir"
    printf 'Unable to place the candidate; the previous version was restored.\n' >&2
    exit 1
  fi
  rm -rf -- "$stage"
  cleanup_stage=0

  if systemctl --user restart codex-pwa.service; then
    port=$(resolve_health_port || true)
    healthy=0
    for _attempt in $(seq 1 80); do
      if [[ -n "$port" ]] && curl --max-time 1 -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then healthy=1; break; fi
      sleep 0.1
    done
  else
    healthy=0
  fi
  if [[ "$healthy" != "1" ]]; then
    printf 'Candidate health check failed; restoring the previous version.\n' >&2
    systemctl --user stop codex-pwa.service 2>/dev/null || true
    mv -- "$app_dir" "$failed"
    mv -- "$backup" "$app_dir"
    systemctl --user restart codex-pwa.service
    printf 'Rollback completed. Failed candidate retained at %s\n' "$failed" >&2
    exit 1
  fi
  prune_old_backups
  printf 'Codex PWA updated to %s. Recoverable previous version: %s\n' \
    "$(node -p 'require(process.argv[1]).version' "$app_dir/package.json")" "$backup"
  exit 0
fi

[[ $# -eq 0 ]] || { usage >&2; exit 2; }
cd -- "$app_dir"

if [[ ! -d .git ]]; then
  printf 'This is a ZIP installation. Download a newer ZIP and run:\n  bash scripts/update-user.sh --zip /path/to/codex-pwa-vX.Y.Z.zip\n' >&2
  exit 2
fi
if [[ -n "$(git status --porcelain)" ]]; then
  printf 'The repository has local changes. Resolve them before updating.\n' >&2
  exit 1
fi
git pull --ff-only
npm ci --omit=dev
npm run check
systemctl --user restart codex-pwa.service
printf 'Codex PWA updated to %s.\n' "$(node -p 'require("./package.json").version')"
