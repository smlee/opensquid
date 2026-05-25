#!/usr/bin/env bash
# G.13 — End-to-end drift-prevention runner.
#
# Convenience wrapper around `pnpm test:e2e`. Sets E2E=1 (the test file's
# describe.skipIf gate) and runs only the composite drift-prevention test
# file so the regular vitest run isn't perturbed. Builds dist/ first when
# stale, since the hook-bin scenarios spawn compiled JS from dist/.
#
# Usage:
#   ./scripts/e2e-runner.sh
#   OPENSQUID_ENGINE_BIN=/path/to/loop-engine ./scripts/e2e-runner.sh
#
# Exit code = vitest exit code. Report is written to
# test/e2e/e2e-drift-prevention-report.md (gitignored, regenerated per run).

set -euo pipefail

cd "$(dirname "$0")/.."

# Build dist/ if it's missing — the hook-bin scenarios spawn compiled bins
# from dist/runtime/hooks/. We don't unconditionally rebuild (slow) — the
# test file's own beforeAll has a stale-dist check too.
if [ ! -f "dist/runtime/hooks/dispatch.js" ]; then
  echo "[e2e-runner] dist/ missing — running pnpm build first"
  pnpm build
fi

echo "[e2e-runner] launching with E2E=1 (engine: ${OPENSQUID_ENGINE_BIN:-<dev-path>})"
exec env E2E=1 pnpm exec vitest run test/e2e/drift-prevention.e2e.test.ts "$@"
