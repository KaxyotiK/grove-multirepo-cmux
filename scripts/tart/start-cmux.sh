#!/bin/bash
# Guest-side. Launch cmux into the GUI session and arm password socket control.
#
# Two things make this necessary:
#   - a GUI app started from an SSH session never reaches the window server, so it must be
#     launched through `launchctl asuser`; `open -a` fails with LaunchServices -10673.
#   - cmux rewrites ~/.config/cmux/cmux.json and strips socketPassword out of it, so external
#     control has to be re-armed after every cmux restart.
#
# Idempotent. Safe to run on every boot. Prints PONG on success.
set -uo pipefail

PWFILE="$HOME/.cmux-test-password"
[ -s "$PWFILE" ] || openssl rand -hex 32 > "$PWFILE"
chmod 600 "$PWFILE"
PW=$(cat "$PWFILE")
CLI=/opt/homebrew/bin/cmux

if ! pgrep -f "cmux.app/Contents/MacOS/cmux" >/dev/null; then
  sudo launchctl asuser "$(id -u)" sudo -u "$USER" \
    /Applications/cmux.app/Contents/MacOS/cmux >/tmp/cmux.log 2>&1 &
  for _ in $(seq 1 60); do
    [ -n "$(ls "$HOME/.local/state/cmux/"*.sock 2>/dev/null)" ] && break
    sleep 1
  done
  sleep 8
fi

mkdir -p "$HOME/.config/cmux"
printf '{ "schemaVersion": 1, "automation": { "socketControlMode": "password", "socketPassword": "%s" } }\n' \
  "$PW" > "$HOME/.config/cmux/cmux.json"
"$CLI" --password "$PW" reload-config >/dev/null 2>&1
sleep 2

CMUX_SOCKET_PASSWORD="$PW" "$CLI" ping
