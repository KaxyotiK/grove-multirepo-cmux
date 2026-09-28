#!/bin/bash
# Guest-side. Build the Grove fixture the live acceptance suite runs against.
#
# Deliberately offline. `grove repo add` takes anything `git clone` accepts, so local bare
# repositories are enough, and that keeps GitHub credentials out of the acceptance path
# entirely. The GitHub fixtures are a separate, richer thing for exercising Grove against real
# remotes; nothing in test/live needs them.
#
# Idempotent: safe to run on every boot, and re-running repairs a partly-built fixture.
#
#   usage: seed-fixture.sh [grove-name] [repo...]
set -euo pipefail

export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin"

GROVE_NAME="${1:-feat-checkout}"
if [ $# -gt 0 ]; then shift; fi
REPOS=("$@")
if [ ${#REPOS[@]} -eq 0 ]; then REPOS=(checkout-api storefront-web design-system); fi

WORKSPACE="$HOME/work"
REMOTES="$HOME/fixture-remotes"

mkdir -p "$REMOTES"

git config --global user.email >/dev/null 2>&1 || git config --global user.email t@example.com
git config --global user.name  >/dev/null 2>&1 || git config --global user.name Tester
git config --global init.defaultBranch main

# 1. A bare repository per fixture repo, with one commit so the trunk exists.
for r in "${REPOS[@]}"; do
  if [ -d "$REMOTES/$r.git" ]; then continue; fi
  tmp="$(mktemp -d)"
  git init -q -b main "$tmp"
  printf '# %s\n' "$r" > "$tmp/README.md"
  mkdir -p "$tmp/src"
  printf 'placeholder\n' > "$tmp/src/main.txt"
  git -C "$tmp" add .
  git -C "$tmp" commit -qm "init $r"
  git clone -q --bare "$tmp" "$REMOTES/$r.git"
  rm -rf "$tmp"
done

# 2. The Grove workspace. Groves land at <workspace>/groves/<name>.
mkdir -p "$WORKSPACE"
if [ ! -d "$WORKSPACE/.grove" ]; then
  grove init "$WORKSPACE" --name work >/dev/null
fi

# 3. Register each repo. `repo add` is not idempotent, so ask first.
#    Written as an if rather than `[ ] || [ ] && continue`, which under `set -e` exits the
#    script the first time both tests fail — the case this loop exists to handle.
for r in "${REPOS[@]}"; do
  if [ -d "$WORKSPACE/repos/$r.git" ] || [ -d "$WORKSPACE/repos/$r" ]; then continue; fi
  grove --workspace "$WORKSPACE" repo add "$REMOTES/$r.git" --name "$r" >/dev/null
done

# 4. The Grove itself, with one Tree per repo.
if [ ! -d "$WORKSPACE/groves/$GROVE_NAME" ]; then
  grove --workspace "$WORKSPACE" new "$GROVE_NAME" --all >/dev/null
fi

# 5. Report what exists, so a caller can assert on it rather than trusting exit 0.
echo "workspace $WORKSPACE"
echo "grove     $WORKSPACE/groves/$GROVE_NAME"
if [ -d "$WORKSPACE/groves/$GROVE_NAME/trees" ]; then
  for d in "$WORKSPACE/groves/$GROVE_NAME/trees"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    top="$(git -C "$d" rev-parse --show-toplevel 2>/dev/null || echo 'NOT-A-WORKTREE')"
    echo "tree      $name -> $top"
  done
fi
echo "SEED_OK"
