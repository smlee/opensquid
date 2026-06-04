#!/usr/bin/env bash
# Pre-push quality gate (PP.1) — run the full CI chain LOCALLY before a push reaches the
# remote, mirroring .github CI. Fail-fast: any red step aborts the push, so a red commit
# never reaches origin (the lapse this prevents: pushing after running only one check).
# `format:check` runs LAST, after any CHANGELOG authoring, per the project rule.
# Bypass (with explicit authorization only): `git push --no-verify`.
set -euo pipefail

run() {
  printf '\n\033[1m▶ pre-push: %s\033[0m\n' "$1"
  shift
  "$@"
}

run "lint" pnpm lint
run "typecheck" pnpm typecheck
run "test" pnpm test
run "build" pnpm build
run "format:check" pnpm format:check

printf '\n\033[32m✓ pre-push gate green — pushing\033[0m\n'
