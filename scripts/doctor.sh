#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
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
printf 'INFO Web UI version %s (protocol baseline 0.148.0; current validation 0.153.2)\n' "$(node -p 'require(process.argv[1]).version' "$script_dir/../package.json")"
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
IFS=':' read -r -a configured_roots <<<"$CODEX_PWA_ROOTS"
for configured_root in "${configured_roots[@]}"; do
  check "Allowed root $configured_root" test -d "$configured_root"
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
