#!/usr/bin/env bash
set -euo pipefail

purge=0
if [[ "${1:-}" == "--purge-config" ]]; then purge=1; fi
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/codex-pwa"

for socket_unit in codex-pwa-private.socket codex-pwa-pgy.socket; do
  systemctl --user disable --now "$socket_unit" 2>/dev/null || true
done
for service_unit in codex-pwa-private.service codex-pwa-pgy.service codex-pwa.service; do
  systemctl --user disable --now "$service_unit" 2>/dev/null || true
done
rm -f -- \
  "$unit_dir/codex-pwa.service" \
  "$unit_dir/codex-pwa-private.socket" \
  "$unit_dir/codex-pwa-private.service" \
  "$unit_dir/codex-pwa-pgy.socket" \
  "$unit_dir/codex-pwa-pgy.service"
systemctl --user daemon-reload
systemctl --user reset-failed codex-pwa.service codex-pwa-private.socket codex-pwa-private.service \
  codex-pwa-pgy.socket codex-pwa-pgy.service 2>/dev/null || true

if [[ "$purge" == "1" ]]; then
  rm -f -- "$config_dir/codex-pwa.env" "$config_dir/access-password" "$config_dir/access-username" "$config_dir/trusted-devices.json"
  rmdir "$config_dir" 2>/dev/null || true
  printf 'PWA services and local PWA credentials were removed.\n'
else
  printf 'PWA services were removed. Credentials remain in %s.\n' "$config_dir"
fi
printf 'The Codex daemon, Codex login, tasks, and repository were not removed.\n'
