#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_root=$(cd -- "$script_dir/.." && pwd -P)
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/codex-pwa"
env_file="$config_dir/codex-pwa.env"
if [[ -f "$env_file" ]]; then
  node_parser=$(command -v node || true)
  if [[ -z "$node_parser" ]]; then
    printf 'Node.js is required to parse %s safely.\n' "$env_file" >&2
    exit 1
  fi
  while IFS= read -r -d '' name && IFS= read -r -d '' value; do
    export "$name=$value"
  done < <("$node_parser" "$script_dir/read-env.mjs" "$env_file")
else
  # Older local installs may keep Environment= entries directly in the
  # user service instead of using the installer-generated env file.
  unit_environment=$(systemctl --user show codex-pwa.service --property=Environment --value 2>/dev/null || true)
  if [[ -z "$unit_environment" ]]; then
    printf 'Missing %s and no usable codex-pwa.service environment was found. Run bash scripts/install-user.sh first.\n' "$env_file" >&2
    exit 1
  fi
  node_parser=$(command -v node || true)
  if [[ -z "$node_parser" ]]; then
    printf 'Node.js is required to parse the legacy service environment safely.\n' >&2
    exit 1
  fi
  while IFS=$'\t' read -r name value; do
    case "$name" in
      CODEX_PWA_*|CODEX_BIN|CODEX_HOME) export "$name=$value" ;;
    esac
  done < <("$node_parser" --input-type=module - "$unit_environment" <<'NODE'
const raw = process.argv[2] || "";
const tokens = [];
let token = "";
let quote = "";
let escaped = false;
for (const character of raw) {
  if (escaped) {
    token += character;
    escaped = false;
  } else if (character === "\\") {
    escaped = true;
  } else if (quote) {
    if (character === quote) quote = "";
    else token += character;
  } else if (character === "'" || character === '"') {
    quote = character;
  } else if (/\s/.test(character)) {
    if (token) {
      tokens.push(token);
      token = "";
    }
  } else {
    token += character;
  }
}
if (escaped) token += "\\";
if (token) tokens.push(token);
for (const assignment of tokens) {
  const separator = assignment.indexOf("=");
  if (separator > 0) process.stdout.write(`${assignment.slice(0, separator)}\t${assignment.slice(separator + 1)}\n`);
}
NODE
  )
  if [[ -z "${CODEX_PWA_PORT:-}" || -z "${CODEX_PWA_ROOTS:-}" || -z "${CODEX_BIN:-}" ]]; then
    printf 'The inline codex-pwa.service environment is incomplete; run bash scripts/install-user.sh first.\n' >&2
    exit 1
  fi
  printf 'WARN using legacy inline codex-pwa.service environment; installer-generated %s was not found.\n' "$env_file"
fi

failed=0
check() {
  local label=$1
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'OK   %s\n' "$label"
  else
    printf 'FAIL %s\n' "$label"
    failed=1
  fi
}

printf 'Codex PWA diagnostics for %s\n' "${USER:-$(id -un)}"
web_ui_version=$(node -p 'require(process.argv[1]).version' "$project_root/package.json")
printf 'INFO Web UI version %s (protocol baseline 0.148.0; current validation 0.153.2)\n' "$web_ui_version"
if git -C "$project_root" rev-parse --verify HEAD >/dev/null 2>&1; then
  source_commit=$(git -C "$project_root" rev-parse --short HEAD)
  source_commit_full=$(git -C "$project_root" rev-parse HEAD)
  source_branch=$(git -C "$project_root" branch --show-current 2>/dev/null || true)
  printf 'INFO Source commit %s%s\n' "$source_commit" "${source_branch:+ on $source_branch}"
  if [[ -n "$(git -C "$project_root" status --porcelain --untracked-files=all)" ]]; then
    printf 'WARN Source checkout has uncommitted or untracked changes; this is a development tree, not a release snapshot.\n'
  else
    printf 'OK   Source checkout is clean\n'
  fi
else
  printf 'WARN Source commit is unavailable; this directory is not a Git checkout.\n'
fi
remote_url=$(git -C "$project_root" config --get remote.origin.url 2>/dev/null || true)
if [[ -n "$remote_url" ]]; then
  remote_main=$(timeout 5s git ls-remote "$remote_url" refs/heads/main 2>/dev/null | awk 'NR == 1 { print $1 }' || true)
  if [[ -n "$remote_main" ]]; then
    printf 'INFO Remote main %s\n' "${remote_main:0:12}"
    if [[ "${source_commit_full:-}" == "$remote_main" ]]; then
      printf 'OK   Source commit matches remote main\n'
    else
      printf 'WARN Source commit differs from remote main\n'
    fi
  else
    printf 'WARN Remote main unavailable; check network or repository access\n'
  fi
  remote_release=$(timeout 5s git ls-remote --tags --refs "$remote_url" 'refs/tags/v*' 2>/dev/null \
    | awk -F/ 'NF >= 3 { print $3 }' | sort -V | tail -n 1 || true)
  local_release=$(git -C "$project_root" tag --sort=-version:refname | head -n 1 || true)
  if [[ -n "$remote_release" ]]; then
    printf 'INFO Remote release %s\n' "$remote_release"
    if [[ -n "$local_release" ]]; then
      printf 'INFO Local release %s\n' "$local_release"
      if [[ "$local_release" == "$remote_release" ]]; then
        printf 'OK   Local release matches remote release\n'
      else
        printf 'WARN Local release differs from remote release\n'
      fi
    else
      printf 'WARN Local release tag is unavailable\n'
    fi
  else
    printf 'WARN Remote release tags unavailable; check network or repository access\n'
  fi
fi
printf 'INFO Configuration format v1; runtime source is expected at %s\n' "$project_root"
IFS=':' read -r -a configured_roots <<<"$CODEX_PWA_ROOTS"
root_summary=$(IFS=', '; printf '%s' "${configured_roots[*]}")
printf 'INFO Allowed roots %s\n' "$root_summary"
home_realpath=$(cd -- "${HOME:-.}" 2>/dev/null && pwd -P || true)
if [[ "${#configured_roots[@]}" -eq 1 && -n "$home_realpath" ]]; then
  configured_root_realpath=$(cd -- "${configured_roots[0]}" 2>/dev/null && pwd -P || true)
  if [[ "$configured_root_realpath" == "$home_realpath" ]]; then
    printf 'WARN Allowed roots cover the entire user home; prefer an explicit project directory for production\n'
  fi
fi
worker_cache=$(sed -n 's/^const CACHE = "\([^"]*\)";/\1/p' "$project_root/public/sw.js" 2>/dev/null || true)
if [[ -n "$worker_cache" ]]; then
  printf 'INFO Service Worker cache %s\n' "$worker_cache"
else
  printf 'WARN Service Worker cache version is unavailable\n'
fi
event_replay_file=${CODEX_PWA_EVENT_REPLAY_FILE:-${CODEX_HOME:-${HOME:-.}/.codex}/pwa-event-replay.jsonl}
printf 'INFO SSE replay file %s\n' "$event_replay_file"
if [[ -f "$event_replay_file" ]]; then
  replay_mode=$(stat -c '%a' "$event_replay_file" 2>/dev/null || true)
  replay_bytes=$(stat -c '%s' "$event_replay_file" 2>/dev/null || true)
  printf 'INFO SSE replay size %s bytes\n' "${replay_bytes:-unknown}"
  if [[ "$replay_mode" == "600" ]]; then
    printf 'OK   SSE replay file permissions 600\n'
  else
    printf 'WARN SSE replay file permissions are %s; expected 600\n' "${replay_mode:-unknown}"
  fi
else
  printf 'INFO SSE replay file has not been created yet\n'
fi
task_recovery_file=${CODEX_PWA_TASK_RECOVERY_FILE:-$(dirname "${CODEX_PWA_SESSION_FILE:-${HOME:-.}/.config/codex-pwa/trusted-devices.json}")/task-recovery.json}
check 'Task recovery journal' node --input-type=module - "$project_root" "$task_recovery_file" <<'NODE'
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { TaskRecovery } = await import(pathToFileURL(`${process.argv[2]}/task-recovery.mjs`));
const file = process.argv[3];
try {
  const details = await stat(file);
  if ((details.mode & 0o777) !== 0o600) throw new Error('permissions');
  const state = new TaskRecovery({ persistencePath: file }).snapshot();
  if (!state.storageHealthy) throw new Error('storage');
  console.log(`INFO Task recovery journal: ${state.tracked} records, permissions 600`);
} catch (error) {
  if (error.code === 'ENOENT') console.log('INFO Task recovery journal has not been created yet');
  else { console.log('WARN Task recovery journal is unreadable, damaged, or has unexpected permissions'); process.exitCode = 1; }
}
NODE
root_accessible() {
  [[ -d "$1" && -r "$1" && -x "$1" ]]
}
if [[ -n "${CODEX_PWA_PUSH_CONFIG_FILE:-}" ]]; then
  check 'Web Push private configuration' node --input-type=module - "$project_root" "$CODEX_PWA_PUSH_CONFIG_FILE" <<'NODE'
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { validateVapidConfiguration } = await import(pathToFileURL(`${process.argv[2]}/push-service.mjs`));
const file = process.argv[3];
const details = await stat(file);
if (!details.isFile() || details.size > 16384 || (details.mode & 0o077)) process.exit(1);
validateVapidConfiguration(JSON.parse(await readFile(file, 'utf8')));
NODE
else
  printf 'INFO Web Push is not configured; page notifications remain available in secure contexts\n'
fi

for configured_root in "${configured_roots[@]}"; do
  check "Allowed root readable/searchable $configured_root" root_accessible "$configured_root"
done
service_working_directory=$(systemctl --user show codex-pwa.service --property=WorkingDirectory --value 2>/dev/null || true)
service_main_pid=$(systemctl --user show codex-pwa.service --property=MainPID --value 2>/dev/null || true)
if [[ -n "$service_working_directory" && "$service_working_directory" != "$project_root" ]]; then
  printf 'WARN PWA service WorkingDirectory is %s, expected %s\n' "$service_working_directory" "$project_root"
elif [[ -n "$service_working_directory" ]]; then
  printf 'OK   PWA service WorkingDirectory matches source checkout\n'
fi
if [[ "$service_main_pid" =~ ^[0-9]+$ && "$service_main_pid" != "0" ]]; then
  printf 'INFO PWA service MainPID %s\n' "$service_main_pid"
fi
check 'Node.js 22+' node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
check 'Codex login' "$CODEX_BIN" login status
daemon_running() {
  local value
  value=$("$CODEX_BIN" app-server daemon version 2>/dev/null) || return 1
  node -e 'const value = JSON.parse(process.argv[1]); process.exit(value.status === "running" ? 0 : 1)' "$value"
}
check 'Codex daemon' daemon_running
daemon_details=$($CODEX_BIN app-server daemon version 2>/dev/null || true)
if [[ -n "$daemon_details" ]]; then
  node -e '
    const value = JSON.parse(process.argv[1]);
    console.log(`INFO Codex CLI ${value.cliVersion || "unknown"}; app-server ${value.appServerVersion || value.managedCodexVersion || "unknown"}`);
    const current = String(value.appServerVersion || value.cliVersion || "0").split(".").map(Number);
    const minimum = [0, 148, 0];
    for (let index = 0; index < 3; index += 1) {
      if ((current[index] || 0) > minimum[index]) break;
      if ((current[index] || 0) < minimum[index]) {
        console.log("WARN this Codex version predates the validated 0.148.0 protocol baseline");
        break;
      }
    }
  ' "$daemon_details" || true
fi
check 'Daemon socket' test -S "$CODEX_PWA_DAEMON_SOCKET"
check 'PWA service' systemctl --user is-active codex-pwa.service
check 'PWA local HTTP' curl -fsS "http://127.0.0.1:$CODEX_PWA_PORT/"
check 'PWA Codex bridge' curl -fsS "http://127.0.0.1:$CODEX_PWA_PORT/api/health"
runtime_health_json=$(curl -fsS --max-time 5 "http://127.0.0.1:$CODEX_PWA_PORT/api/health" 2>/dev/null || true)
runtime_status_json="$runtime_health_json"
if [[ -z "$runtime_status_json" ]]; then
  runtime_status_json=$(curl -fsS --max-time 5 "http://127.0.0.1:$CODEX_PWA_PORT/api/status" 2>/dev/null || true)
fi
if [[ -n "$runtime_status_json" ]]; then
  runtime_version=$(node -e '
    try {
      const status = JSON.parse(process.argv[1]);
      process.stdout.write(String(status.version || ""));
    } catch {}
  ' "$runtime_status_json")
  if [[ -n "$runtime_version" ]]; then
    printf 'INFO Running Web UI version %s\n' "$runtime_version"
    if [[ "$runtime_version" == "$web_ui_version" ]]; then
      printf 'OK   Running Web UI version matches source\n'
    else
      printf 'WARN Running Web UI version differs from source version %s\n' "$web_ui_version"
    fi
  else
    printf 'WARN Running Web UI version is unavailable; API may require authentication\n'
  fi
else
  printf 'WARN Running Web UI status is unavailable; API may require authentication\n'
fi
for configured_root in "${configured_roots[@]}"; do
  check "Allowed root exists $configured_root" test -d "$configured_root"
done

if systemctl --user cat codex-pwa-private.socket >/dev/null 2>&1; then
  check 'Private-network socket' systemctl --user is-active codex-pwa-private.socket
elif systemctl --user cat codex-pwa-pgy.socket >/dev/null 2>&1; then
  check 'Legacy private-network socket' systemctl --user is-active codex-pwa-pgy.socket
  printf 'WARN legacy codex-pwa-pgy units will be migrated by the next setup run\n'
fi

linger=$(loginctl show-user "${USER:-$(id -un)}" -p Linger --value 2>/dev/null || true)
if [[ "$linger" == "yes" ]]; then
  printf 'OK   systemd linger enabled\n'
else
  printf 'WARN systemd linger is disabled; services may stop after logout\n'
fi

exit "$failed"
