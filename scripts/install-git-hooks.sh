#!/usr/bin/env bash
# Install the repo's git hooks (PP.1). Run automatically by the `prepare` npm script on
# `pnpm install`, and idempotent so it is safe to re-run. Writes `.git/hooks/pre-push` to
# run the pre-push quality gate (`pnpm prepush`).
#
# The installed hook is PLAIN (no `@opensquid` marker) on purpose: if `opensquid gate
# install` (GF.2) runs later it CHAINS its flow-gate onto this hook rather than clobbering
# it, so the quality gate and the flow gate compose. We also refuse to overwrite a hook
# that already calls `pnpm prepush` (which a chained version still does), so re-running
# `prepare` never wipes the chained gate.
#
# Skipped silently outside a git work tree (e.g. an npm-tarball install).
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$root" ] && exit 0

hook="$root/.git/hooks/pre-push"
if [ -f "$hook" ] && grep -q 'pnpm prepush' "$hook"; then
  exit 0 # already installed (or chained) — do not clobber
fi

mkdir -p "$root/.git/hooks"
cat >"$hook" <<'EOF'
#!/bin/sh
# opensquid repo pre-push quality gate — installed by scripts/install-git-hooks.sh (PP.1).
exec pnpm prepush
EOF
chmod +x "$hook"
echo "installed .git/hooks/pre-push → pnpm prepush"
