#!/usr/bin/env bash
# Install the repo's git hooks (PP.1). Run automatically by the `prepare` npm script on
# `pnpm install`, and idempotent so it is safe to re-run. Writes `.git/hooks/pre-push` to
# run the pre-push quality gate (`pnpm prepush`).
#
# Composition contract with `opensquid gate install` (GF.2 / PGB.1): the managed flow
# gate ALWAYS rides FIRST (directly after the shebang) and this quality chain runs below
# it. If GF.2's marker is already present we INSERT the quality line below the managed
# block instead of rewriting (rewriting with `exec pnpm prepush` above the marker is what
# made the flow gate unreachable dead code — the 2026-06-10 push bypass). We also refuse
# to touch a hook that already calls `pnpm prepush`, so re-running `prepare` is a no-op.
#
# Skipped silently outside a git work tree (e.g. an npm-tarball install).
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$root" ] && exit 0

hook="$root/.git/hooks/pre-push"
if [ -f "$hook" ] && grep -q 'pnpm prepush' "$hook"; then
  exit 0 # already installed (or chained) — do not clobber
fi
if [ -f "$hook" ] && grep -q '@opensquid managed hook' "$hook"; then
  # GF.2-managed hook present — append the quality chain BELOW the gate, never rewrite.
  printf '%s\n' 'pnpm prepush || exit $?' >>"$hook"
  echo "chained pnpm prepush below the opensquid gate in .git/hooks/pre-push"
  exit 0
fi

mkdir -p "$root/.git/hooks"
cat >"$hook" <<'EOF'
#!/bin/sh
# opensquid repo pre-push quality gate — installed by scripts/install-git-hooks.sh (PP.1).
exec pnpm prepush
EOF
chmod +x "$hook"
echo "installed .git/hooks/pre-push → pnpm prepush"
