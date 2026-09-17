#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
app_dir=$(cd -- "$script_dir/.." && pwd -P)
app_parent=$(dirname -- "$app_dir")
backup_prefix=".codex-pwa-backup-$(printf '%s' "$app_dir" | sha256sum | cut -c1-16)-"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/update-user.sh                 Stage and atomically update a clean Git checkout
  bash scripts/update-user.sh --zip FILE.zip  Atomically update a ZIP installation
  bash scripts/update-user.sh --health-port   Print the configured local health-check port
EOF
}

prune_old_backups() {
  local keep=3 index candidate
  local -a backups=()
  mapfile -t backups < <(
    find "$app_parent" -mindepth 1 -maxdepth 1 -type d -name "$backup_prefix*" -printf '%T@ %p\n' \
      | sort -rn | cut -d' ' -f2-
  )
  for ((index = keep; index < ${#backups[@]}; index += 1)); do
    candidate=${backups[index]}
    if [[ "$(dirname -- "$candidate")" == "$app_parent" && "$(basename -- "$candidate")" == "$backup_prefix"* ]]; then
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

verify_runtime() {
  local expected_version=$1 expected_worker_hash=$2 health_json runtime_version sw_hash
  for _attempt in $(seq 1 80); do
    if health_json=$(curl --max-time 1 -fsS "http://127.0.0.1:$port/api/health" 2>/dev/null); then
      runtime_version=$(node -e '
        try {
          const payload = JSON.parse(process.argv[1]);
          if (payload.ok === true) process.stdout.write(String(payload.version || ""));
        } catch {}
      ' "$health_json" 2>/dev/null || true)
      sw_hash=$(curl --max-time 1 -fsS "http://127.0.0.1:$port/sw.js" 2>/dev/null | sha256sum | cut -d' ' -f1 || true)
      if [[ "$runtime_version" == "$expected_version" && "$sw_hash" == "$expected_worker_hash" ]]; then
        return 0
      fi
    fi
    sleep 0.1
  done
  return 1
}

if [[ "${1:-}" == "--health-port" ]]; then
  [[ $# -eq 1 ]] || { usage >&2; exit 2; }
  resolve_health_port
  exit $?
fi

command -v flock >/dev/null 2>&1 || { printf 'flock is required for safe updates.\n' >&2; exit 1; }
exec 9>"$app_parent/.codex-pwa-update-$(basename -- "$app_dir").lock"
if ! flock -n 9; then
  printf 'Another update is already in progress for this installation.\n' >&2
  exit 1
fi

cleanup_stage=0
trap 'if [[ "${cleanup_stage:-0}" == "1" ]]; then rm -rf -- "$stage"; fi' EXIT
git_update=0

if [[ "${1:-}" == "--zip" ]]; then
  archive=${2:?missing ZIP archive path}
  [[ $# -eq 2 ]] || { usage >&2; exit 2; }
  archive=$(realpath -- "$archive")
  [[ -f "$archive" ]] || { printf 'ZIP archive was not found: %s\n' "$archive" >&2; exit 2; }
  command -v unzip >/dev/null 2>&1 || { printf 'unzip is required for ZIP updates.\n' >&2; exit 1; }

  stage=$(mktemp -d "$app_parent/.codex-pwa-update.XXXXXX")
  cleanup_stage=1
  unzip -q "$archive" -d "$stage"
  mapfile -t candidates < <(find "$stage" -mindepth 1 -maxdepth 1 -type d -name 'codex-pwa-v*' -print)
  if [[ ${#candidates[@]} -ne 1 || ! -f "${candidates[0]}/package.json" ]]; then
    printf 'The archive must contain exactly one codex-pwa-v*/ package root.\n' >&2
    exit 1
  fi
  candidate=${candidates[0]}
  node "$script_dir/verify-release-manifest.mjs" "$candidate"
else
  [[ $# -eq 0 ]] || { usage >&2; exit 2; }
  if [[ -f "$app_dir/.git" || -L "$app_dir/.git" ]]; then
    printf 'Use a standalone Git checkout for automatic updates; linked worktrees are not moved.\n' >&2
    exit 1
  fi
  if [[ ! -d "$app_dir/.git" ]]; then
    printf 'This is a ZIP installation. Download a newer ZIP and run:\n  bash scripts/update-user.sh --zip /path/to/codex-pwa-vX.Y.Z.zip\n' >&2
    exit 2
  fi
  if [[ -n "$(git -C "$app_dir" status --porcelain --untracked-files=all)" ]]; then
    printf 'The repository has local changes. Resolve them before updating.\n' >&2
    exit 1
  fi
  if [[ $(git -C "$app_dir" worktree list --porcelain | grep -c '^worktree ') != 1 ]] \
      || [[ -n "$(git -C "$app_dir" config --get core.worktree || true)" ]]; then
    printf 'Use a standalone Git checkout without linked worktrees or an external work tree.\n' >&2
    exit 1
  fi
  branch=$(git -C "$app_dir" symbolic-ref --quiet --short HEAD || true)
  [[ -n "$branch" ]] || { printf 'Checkout a tracking branch before updating; detached HEAD is unchanged.\n' >&2; exit 1; }
  remote=$(git -C "$app_dir" config --get "branch.$branch.remote" || true)
  upstream_ref=$(git -C "$app_dir" config --get "branch.$branch.merge" || true)
  if [[ -z "$remote" || -z "$upstream_ref" ]]; then
    printf 'The current branch has no configured upstream; installation unchanged.\n' >&2
    exit 1
  fi
  original_head=$(git -C "$app_dir" rev-parse HEAD)
  stage=$(mktemp -d "$app_parent/.codex-pwa-update.XXXXXX")
  cleanup_stage=1
  candidate="$stage/candidate"
  # An independent copy preserves local config, ignored deployment files and
  # all Git objects without moving the live checkout or sharing a worktree index.
  cp -a -- "$app_dir" "$candidate"
  pull_options=(-c core.hooksPath=/dev/null)
  if [[ "$remote" != "." ]]; then
    remote_url=$(git -C "$app_dir" remote get-url "$remote")
    # Relative filesystem remotes are relative to the original working tree,
    # not the staging directory. Override only this pull, retaining the config.
    if [[ "$remote_url" != /* && "$remote_url" != *:* && "$remote_url" != '~'* ]]; then
      resolved_remote_url=$(realpath -m -- "$app_dir/$remote_url")
      pull_options+=(-c "url.$resolved_remote_url.insteadOf=$remote_url")
    fi
  fi
  git -C "$candidate" "${pull_options[@]}" pull --ff-only
  if [[ "$(git -C "$candidate" rev-parse HEAD)" == "$original_head" ]]; then
    printf 'Already current; the running service was not restarted.\n'
    exit 0
  fi
  git_update=1
fi

candidate_version=$(node -p 'require(process.argv[1]).version' "$candidate/package.json")
candidate_worker_hash=$(sha256sum "$candidate/public/sw.js" | cut -d' ' -f1)
previous_version=$(node -p 'require(process.argv[1]).version' "$app_dir/package.json")
previous_worker_hash=$(sha256sum "$app_dir/public/sw.js" | cut -d' ' -f1)
port=$(resolve_health_port || true)
[[ -n "$port" ]] || { printf 'Unable to determine the configured health-check port; installation unchanged.\n' >&2; exit 1; }
printf 'Preparing and testing candidate %s...\n' "$candidate_version"
(
  cd -- "$candidate"
  npm ci --omit=dev
  npm run check
)

if [[ "$git_update" == "1" ]] && { [[ "$(git -C "$app_dir" rev-parse HEAD)" != "$original_head" ]] \
    || [[ -n "$(git -C "$app_dir" status --porcelain --untracked-files=all)" ]]; }; then
  printf 'The live checkout changed while testing; installation unchanged.\n' >&2
  exit 1
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=$(mktemp -d "$app_parent/$backup_prefix$stamp.XXXXXX")
rmdir -- "$backup"
failed="$app_parent/.codex-pwa-failed-${backup##*/.codex-pwa-backup-}"
mv -- "$app_dir" "$backup"
if ! mv -- "$candidate" "$app_dir"; then
  mv -- "$backup" "$app_dir"
  printf 'Unable to place the candidate; the previous version was restored.\n' >&2
  exit 1
fi
rm -rf -- "$stage"
cleanup_stage=0

if ! systemctl --user restart codex-pwa.service || ! verify_runtime "$candidate_version" "$candidate_worker_hash"; then
  printf 'Candidate health check failed; restoring the previous version.\n' >&2
  systemctl --user stop codex-pwa.service 2>/dev/null || true
  mv -- "$app_dir" "$failed"
  mv -- "$backup" "$app_dir"
  if ! systemctl --user restart codex-pwa.service || ! verify_runtime "$previous_version" "$previous_worker_hash"; then
    printf 'Previous files restored, but service health could not be confirmed. Failed candidate retained at %s\n' "$failed" >&2
    exit 1
  fi
  printf 'Rollback completed. Failed candidate retained at %s\n' "$failed" >&2
  exit 1
fi
prune_old_backups
printf 'Codex PWA updated to %s. Recoverable previous version: %s\n' \
  "$(node -p 'require(process.argv[1]).version' "$app_dir/package.json")" "$backup"
