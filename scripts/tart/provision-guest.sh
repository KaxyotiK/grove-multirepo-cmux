#!/bin/bash
# Host-side. Provision a freshly cloned Cirrus Labs macOS guest into a grove-cmux test host.
#
# Assumes the VM is already running and the Tart guest agent is answering `tart exec`.
# Leaves Claude Code and Codex installed but signed out; both need one interactive login,
# which is the only manual step for those two. Neither is needed by the acceptance suite.
#
# The acceptance fixture is built by seed-fixture.sh, which is offline and needs no
# credentials. GitHub sign-in is optional and only for exercising Grove against real remotes.
# See README.md in this directory.
#
# usage: provision-guest.sh <vm-name>
set -euo pipefail

VM="${1:?usage: provision-guest.sh <vm-name>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say() { printf '\n== %s\n' "$1"; }

say "waiting for guest agent"
for _ in $(seq 1 80); do
  timeout 15 tart exec "$VM" /bin/sh -lc 'echo READY' 2>/dev/null | grep -q READY && break
  sleep 3
done

say "passwordless sudo and host ssh key"
KEY="$(cat "$HOME/.ssh/id_ed25519.pub")"
tart exec "$VM" /bin/sh -lc '
  echo admin | sudo -S sh -c "echo \"admin ALL=(ALL) NOPASSWD: ALL\" > /etc/sudoers.d/admin-nopasswd; chmod 440 /etc/sudoers.d/admin-nopasswd" 2>/dev/null
  sudo -n true && echo NOPASSWD_OK'
tart exec "$VM" /bin/sh -lc "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$KEY' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_OK"

IP="$(tart ip "$VM")"
cat > "$WORK/ssh_config" <<EOF
Host guest
  HostName $IP
  User admin
  IdentityFile $HOME/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
  ConnectTimeout 10
EOF
SSH=(ssh -F "$WORK/ssh_config" guest)
SCP=(scp -F "$WORK/ssh_config")

say "copying artifacts"
HERDR_BIN="$(command -v herdr)" || { echo "herdr is not on PATH" >&2; exit 1; }
"${SCP[@]}" "$HERDR_BIN" "$HERE/start-cmux.sh" "$HERE/seed-fixture.sh" guest:/tmp/

say "installing cmux, grove, herdr, codex, claude"
"${SSH[@]}" bash -lc "
  set -x
  mkdir -p ~/.local/bin
  install -m 755 /tmp/herdr    ~/.local/bin/herdr
  install -m 755 /tmp/start-cmux.sh ~/.local/bin/start-cmux.sh
  install -m 755 /tmp/seed-fixture.sh ~/.local/bin/seed-fixture.sh
  xattr -dr com.apple.quarantine ~/.local/bin/herdr 2>/dev/null
  NONINTERACTIVE=1 brew install --cask cmux
  NONINTERACTIVE=1 brew install gh
  npm i -g grove-multirepo
  npm i -g @openai/codex
  curl -fsSL https://claude.ai/install.sh | bash
  for f in ~/.zprofile ~/.zshrc ~/.bash_profile ~/.profile; do
    grep -q '.local/bin' \$f 2>/dev/null || echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> \$f
  done
  rm -f /tmp/herdr /tmp/start-cmux.sh /tmp/seed-fixture.sh
"

say "dark mode (needs the reboot below to take effect)"
"${SSH[@]}" 'sudo launchctl asuser $(id -u) osascript -e "tell application \"System Events\" to tell appearance preferences to set dark mode to true"'

say "git identity for grove fixtures"
"${SSH[@]}" 'git config --global user.email t@example.com; git config --global user.name Tester; git config --global init.defaultBranch main'

say "rebooting so the appearance change lands"
"${SSH[@]}" 'sudo shutdown -r now' || true
sleep 20
for _ in $(seq 1 80); do
  timeout 15 tart exec "$VM" /bin/sh -lc 'echo READY' 2>/dev/null | grep -q READY && break
  sleep 3
done

say "starting cmux"
tart exec "$VM" /bin/sh -lc '~/.local/bin/start-cmux.sh'

say "seeding the acceptance fixture (offline; no credentials)"
tart exec "$VM" /bin/sh -lc '~/.local/bin/seed-fixture.sh'

say "installed versions"
tart exec "$VM" /bin/bash -lc 'export PATH=$HOME/.local/bin:$PATH
  for t in cmux grove herdr gh claude codex; do printf "%-7s %s\n" "$t" "$($t --version 2>&1 | head -1)"; done
  echo; cmux version'

cat <<'DONE'

Provisioned, and the acceptance fixture exists. The live suite can run against this guest now.

Optional, and only if you want the agents or real GitHub remotes in the image:
  - sign in to Claude Code and Codex once (see README.md for both login flows)
  - gh auth login, then seed remote repos

Freeze afterwards so every clone starts ready:
  tart stop <vm> && tart clone <vm> gcx-base
DONE
