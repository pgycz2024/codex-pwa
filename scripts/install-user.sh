#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/install-user.sh [options]

Options:
  --port PORT             Private-network port (default: first free port in 4177-4277)
  --root PATH             Only expose this project root (default: current user's home)
  --private-ip IP         Bind the private-network proxy to this IP
  --loopback-only         Do not create a private-network listener
  --instance-name NAME    Name shown in the Web UI
  --skip-daemon-bootstrap Use an already-running Codex daemon
  --yes                   Non-interactive setup with generated password
  --dry-run               Generate configuration without starting services
  -h, --help              Show this help
EOF
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
app_dir=$(cd -- "$script_dir/.." && pwd -P)
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/codex-pwa"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
existing_env="$config_dir/codex-pwa.env"
root_dir="$HOME"
port=""
private_ip=""
instance_name="${USER:-user} 的 Codex"
loopback_only=0
root_explicit=0
port_explicit=0
network_explicit=0
instance_name_explicit=0
reuse_existing_port=0
skip_daemon_bootstrap=0
non_interactive=0
dry_run=${CODEX_PWA_SETUP_DRY_RUN:-0}

while (($#)); do
  case "$1" in
    --port) port=${2:?missing port}; port_explicit=1; shift 2 ;;
    --root) root_dir=${2:?missing root path}; root_explicit=1; shift 2 ;;
    --private-ip) private_ip=${2:?missing private IP}; network_explicit=1; shift 2 ;;
    --loopback-only) loopback_only=1; network_explicit=1; shift ;;
    --instance-name) instance_name=${2:?missing instance name}; instance_name_explicit=1; shift 2 ;;
    --skip-daemon-bootstrap) skip_daemon_bootstrap=1; shift ;;
    --yes) non_interactive=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

node_bin=$(command -v node || true)
npm_bin=$(command -v npm || true)
if [[ -z "$node_bin" || -z "$npm_bin" ]]; then
  printf 'Node.js and npm are required. Install Node.js 22 or newer first.\n' >&2
  exit 1
fi

existing_network_label=""
existing_configured_port=""
if [[ -f "$existing_env" ]]; then
  while IFS= read -r -d '' name && IFS= read -r -d '' value; do
    case "$name" in
      CODEX_PWA_PORT)
        existing_configured_port=$value
        if [[ "$port_explicit" != "1" ]]; then port=$value; reuse_existing_port=1; fi
        ;;
      CODEX_PWA_ROOTS)
        if [[ "$root_explicit" != "1" ]]; then root_dir=$value; fi
        ;;
      CODEX_PWA_INSTANCE_NAME)
        if [[ "$instance_name_explicit" != "1" ]]; then instance_name=$value; fi
        ;;
      CODEX_PWA_PRIVATE_IP)
        if [[ "$network_explicit" != "1" ]]; then private_ip=$value; fi
        ;;
      CODEX_PWA_LOOPBACK_ONLY)
        if [[ "$network_explicit" != "1" && "$value" == "1" ]]; then loopback_only=1; fi
        ;;
      CODEX_PWA_NETWORK_LABEL) existing_network_label=$value ;;
    esac
  done < <("$node_bin" "$script_dir/read-env.mjs" "$existing_env")
fi
if [[ "$port_explicit" == "1" && -n "$existing_configured_port" && "$port" == "$existing_configured_port" ]]; then
  reuse_existing_port=1
fi

if [[ "$network_explicit" != "1" && -z "$private_ip" ]]; then
  if [[ "$existing_network_label" == "本机端口"* ]]; then
    loopback_only=1
  elif [[ "$existing_network_label" == "蒲公英私网 · "* ]]; then
    private_endpoint=${existing_network_label#蒲公英私网 · }
    private_ip=${private_endpoint%:*}
  fi
fi

for value in "$app_dir" "$root_dir" "$instance_name" "$private_ip"; do
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    printf 'Configuration values may not contain newlines.\n' >&2
    exit 2
  fi
done
IFS=':' read -r -a configured_roots <<<"$root_dir"
canonical_roots=()
for configured_root in "${configured_roots[@]}"; do
  if [[ -z "$configured_root" || ! -d "$configured_root" ]]; then
    printf 'Allowed root does not exist: %s\n' "$configured_root" >&2
    exit 2
  fi
  canonical_roots+=("$(cd -- "$configured_root" && pwd -P)")
done
root_dir=$(IFS=:; printf '%s' "${canonical_roots[*]}")

codex_bin=${CODEX_BIN:-$(command -v codex || true)}
node_major=$($node_bin -p 'Number(process.versions.node.split(".")[0])')
if ((node_major < 22)); then
  printf 'Node.js 22 or newer is required; found %s.\n' "$($node_bin --version)" >&2
  exit 1
fi
if [[ -z "$codex_bin" && "$dry_run" != "1" ]]; then
  printf 'Codex CLI was not found in PATH. Install/login to Codex first.\n' >&2
  exit 1
fi
if [[ -z "$codex_bin" ]]; then codex_bin="$HOME/.local/bin/codex"; fi

if [[ "$loopback_only" != "1" && -z "$private_ip" ]]; then
  private_ip=$(ip -4 -o addr show dev oray_vnc 2>/dev/null | awk 'NR == 1 { split($4, part, "/"); print part[1] }' || true)
fi
if [[ "$loopback_only" != "1" && -n "$private_ip" && "$dry_run" != "1" ]]; then
  if ! ip -4 -o addr show | awk '{ split($4, part, "/"); print part[1] }' | grep -Fxq "$private_ip"; then
    printf 'Private IP %s is not assigned to this server.\n' "$private_ip" >&2
    exit 2
  fi
fi

port_in_use() {
  ss -H -ltn 2>/dev/null | awk '{ print $4 }' | grep -Eq "(^|[.:])$1$"
}

if [[ -z "$port" && -f "$existing_env" ]]; then
  port=$(sed -n 's/^CODEX_PWA_PORT="\{0,1\}\([0-9][0-9]*\)"\{0,1\}$/\1/p' "$existing_env" | head -1)
  if [[ -n "$port" ]]; then reuse_existing_port=1; fi
fi
if [[ -z "$port" ]]; then
  for candidate in $(seq 4177 4277); do
    if ! port_in_use "$candidate"; then port=$candidate; break; fi
  done
fi
if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
  printf 'Port must be an integer between 1024 and 65535.\n' >&2
  exit 2
fi
if [[ "$dry_run" != "1" && "$reuse_existing_port" != "1" ]] && port_in_use "$port"; then
  printf 'Port %s is already in use. Choose another port with --port.\n' "$port" >&2
  exit 1
fi

if [[ "$non_interactive" != "1" && "$dry_run" != "1" ]]; then
  printf '\nCodex PWA per-user setup\n'
  printf '  App directory : %s\n' "$app_dir"
  printf '  Allowed files : %s\n' "$root_dir"
  printf '  Web UI port   : %s\n' "$port"
  if [[ "$loopback_only" == "1" || -z "$private_ip" ]]; then
    printf '  Network       : loopback only\n'
  else
    printf '  Network       : %s\n' "$private_ip"
  fi
  read -r -p 'Continue? [Y/n] ' reply
  if [[ "$reply" =~ ^[Nn]$ ]]; then exit 0; fi
fi

if [[ "$dry_run" != "1" ]]; then
  printf 'Installing Node dependencies...\n'
  "$npm_bin" ci --omit=dev
  if ! "$codex_bin" login status >/dev/null; then
    printf 'Codex is not logged in for user %s. Run codex login first.\n' "${USER:-unknown}" >&2
    exit 1
  fi
  if [[ "$skip_daemon_bootstrap" != "1" ]]; then
    if ! "$codex_bin" app-server daemon bootstrap --help >/dev/null 2>&1; then
      printf 'This Codex CLI is too old for durable daemon bootstrap. Update Codex first.\n' >&2
      exit 1
    fi
    printf 'Installing durable Codex app-server management...\n'
    "$codex_bin" app-server daemon bootstrap
    "$codex_bin" app-server daemon start
  fi
  daemon_json=$($codex_bin app-server daemon version)
  daemon_socket=$($node_bin -e '
    const value = JSON.parse(process.argv[1]);
    if (value.status !== "running" || !value.socketPath) process.exit(1);
    process.stdout.write(value.socketPath);
  ' "$daemon_json") || {
    printf 'The Codex app-server daemon is not running.\n' >&2
    exit 1
  }
else
  daemon_socket="$HOME/.codex/app-server-control/app-server-control.sock"
fi

umask 077
mkdir -p -- "$config_dir" "$unit_dir"
chmod 700 "$config_dir" "$unit_dir"
password_file="$config_dir/access-password"
username_file="$config_dir/access-username"
session_file="$config_dir/trusted-devices.json"
created_password=""
if [[ ! -s "$password_file" ]]; then
  created_password=$($node_bin -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("base64url"))')
  printf '%s\n' "$created_password" >"$password_file"
  chmod 600 "$password_file"
fi
if [[ ! -s "$username_file" ]]; then
  printf 'codex\n' >"$username_file"
  chmod 600 "$username_file"
fi

env_value() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}

systemd_value() {
  local value=$1
  value=${value//%/%%}
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}

systemd_path_value() {
  local value=$1
  # WorkingDirectory= and EnvironmentFile= parse quotes as path characters.
  # Their entire right-hand side is already one value, including spaces.
  value=${value//%/%%}
  printf '%s' "$value"
}

env_file="$config_dir/codex-pwa.env"
{
  printf 'CODEX_PWA_HOST=%s\n' "$(env_value '127.0.0.1')"
  printf 'CODEX_PWA_PORT=%s\n' "$(env_value "$port")"
  printf 'CODEX_PWA_ROOTS=%s\n' "$(env_value "$root_dir")"
  printf 'CODEX_BIN=%s\n' "$(env_value "$codex_bin")"
  printf 'CODEX_HOME=%s\n' "$(env_value "$HOME/.codex")"
  printf 'CODEX_PWA_APP_SERVER_MODE=%s\n' "$(env_value 'shared-daemon')"
  printf 'CODEX_PWA_DAEMON_SOCKET=%s\n' "$(env_value "$daemon_socket")"
  printf 'CODEX_PWA_PASSWORD_FILE=%s\n' "$(env_value "$password_file")"
  printf 'CODEX_PWA_USERNAME_FILE=%s\n' "$(env_value "$username_file")"
  printf 'CODEX_PWA_SESSION_FILE=%s\n' "$(env_value "$session_file")"
  printf 'CODEX_PWA_INSTANCE_NAME=%s\n' "$(env_value "$instance_name")"
  printf 'CODEX_PWA_PRIVATE_IP=%s\n' "$(env_value "$private_ip")"
  printf 'CODEX_PWA_LOOPBACK_ONLY=%s\n' "$(env_value "$loopback_only")"
  if [[ "$loopback_only" == "1" || -z "$private_ip" ]]; then
    network_label="本机端口 · 127.0.0.1:$port"
  else
    network_label="蒲公英私网 · $private_ip:$port"
  fi
  printf 'CODEX_PWA_NETWORK_LABEL=%s\n' "$(env_value "$network_label")"
} >"$env_file"
chmod 600 "$env_file"

cat >"$unit_dir/codex-pwa.service" <<EOF
[Unit]
Description=Codex mobile PWA bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$(systemd_path_value "$app_dir")
ExecStart=$(systemd_value "$node_bin") $(systemd_value "$app_dir/server.mjs")
Environment=NODE_ENV=production
EnvironmentFile=$(systemd_path_value "$env_file")
Restart=on-failure
RestartSec=3
UMask=0077
MemoryHigh=768M
MemoryMax=1G
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
chmod 600 "$unit_dir/codex-pwa.service"

private_url=""
if [[ "$loopback_only" != "1" && -n "$private_ip" ]]; then
  if [[ "$dry_run" == "1" ]]; then
    socket_proxy=/usr/lib/systemd/systemd-socket-proxyd
  else
    socket_proxy=$(command -v systemd-socket-proxyd 2>/dev/null || true)
    if [[ -z "$socket_proxy" ]]; then
      for candidate in /usr/lib/systemd/systemd-socket-proxyd /lib/systemd/systemd-socket-proxyd; do
        if [[ -x "$candidate" ]]; then socket_proxy=$candidate; break; fi
      done
    fi
    if [[ -z "$socket_proxy" ]]; then
      printf 'systemd-socket-proxyd was not found; use --loopback-only or ask the administrator.\n' >&2
      exit 1
    fi
  fi
  cat >"$unit_dir/codex-pwa-private.socket" <<EOF
[Unit]
Description=Private-network listener for Codex PWA

[Socket]
ListenStream=$private_ip:$port
NoDelay=true
FreeBind=true

[Install]
WantedBy=sockets.target
EOF
  cat >"$unit_dir/codex-pwa-private.service" <<EOF
[Unit]
Description=Forward private-network traffic to the local Codex PWA
Requires=codex-pwa.service
After=codex-pwa.service

[Service]
ExecStart=$(systemd_value "$socket_proxy") 127.0.0.1:$port
NoNewPrivileges=true
PrivateTmp=true
EOF
  chmod 600 "$unit_dir/codex-pwa-private.socket" "$unit_dir/codex-pwa-private.service"
  private_url="http://$private_ip:$port"
fi

if [[ "$dry_run" != "1" ]]; then
  if command -v systemd-analyze >/dev/null 2>&1; then
    unit_files=("$unit_dir/codex-pwa.service")
    if [[ -n "$private_url" ]]; then
      unit_files+=("$unit_dir/codex-pwa-private.socket" "$unit_dir/codex-pwa-private.service")
    fi
    systemd-analyze --user verify "${unit_files[@]}"
  fi
  # v0.11 and older used the deployment-specific "pgy" unit name. Retire it
  # before enabling the generic private-network proxy so only one listener is
  # left behind after an in-place reinstall.
  systemctl --user disable --now codex-pwa-pgy.socket 2>/dev/null || true
  systemctl --user stop codex-pwa-pgy.service 2>/dev/null || true
  rm -f -- "$unit_dir/codex-pwa-pgy.socket" "$unit_dir/codex-pwa-pgy.service"
  # Stop both sides of the socket-activated proxy before restarting the main
  # service. Otherwise the old socket may reactivate the proxy mid-reinstall,
  # and systemd then refuses to restart the socket while its service is active.
  systemctl --user stop codex-pwa-private.socket 2>/dev/null || true
  systemctl --user stop codex-pwa-private.service 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable codex-pwa.service
  systemctl --user restart codex-pwa.service
  if [[ -n "$private_url" ]]; then
    systemctl --user enable codex-pwa-private.socket
    systemctl --user start codex-pwa-private.socket
  else
    systemctl --user disable codex-pwa-private.socket 2>/dev/null || true
  fi
  for attempt in $(seq 1 80); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null
fi

printf '\nSetup complete.\n'
if [[ -n "$private_url" ]]; then
  printf 'Open on a device connected to the same private network: %s\n' "$private_url"
else
  printf 'Loopback URL: http://127.0.0.1:%s\n' "$port"
  printf 'Use an SSH tunnel or configure a private-network listener later.\n'
fi
login_username=$(tr -d '\r\n' <"$username_file")
printf 'Login username: %s\n' "$login_username"
if [[ -n "$created_password" ]]; then
  printf 'Initial password: %s\n' "$created_password"
  printf 'Save it now. It is stored only in %s\n' "$password_file"
else
  printf 'The existing Web UI password was preserved.\n'
fi

if command -v loginctl >/dev/null 2>&1; then
  linger=$(loginctl show-user "${USER:-$(id -un)}" -p Linger --value 2>/dev/null || true)
  if [[ "$linger" != "yes" ]]; then
    printf '\nAdministrator action required for service persistence after logout:\n'
    printf '  sudo loginctl enable-linger %s\n' "${USER:-$(id -un)}"
  fi
fi
