#!/usr/bin/env bash
set -euo pipefail

config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/codex-pwa"
password_file="$config_dir/access-password"
mkdir -p -- "$config_dir"
chmod 700 "$config_dir"

read -r -s -p 'New Web UI password (at least 8 characters): ' first
printf '\n'
read -r -s -p 'Repeat password: ' second
printf '\n'
if [[ "$first" != "$second" ]]; then
  printf 'Passwords do not match.\n' >&2
  exit 1
fi
if ((${#first} < 8)); then
  printf 'Password must contain at least 8 characters.\n' >&2
  exit 1
fi
umask 077
printf '%s\n' "$first" >"$password_file"
chmod 600 "$password_file"
systemctl --user restart codex-pwa.service
printf 'Password updated. Previously trusted devices must log in again.\n'
