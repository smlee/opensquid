import { defineConfig } from 'vitest/config';

/**
 * Vitest config — scopes default test discovery to src/ + test/ (new
 * architecture). src.legacy/ is the Phase 0 archive of the pre-reset code;
 * its tests have known daemon-lifecycle flakes (pidfile timeout race) that
 * predate the reset and would gate CI red on every push.
 *
 * Legacy tests are deleted as src/ replaces them (Phases 5+). Until then,
 * exclude src.legacy/ from default `pnpm test` so CI surfaces real
 * regressions in the new architecture — not noise in the archive.
 *
 * To still run legacy tests on demand:
 *   pnpm exec vitest run src.legacy/
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'src.legacy/**'],
    // Safety net for stray `loop-engine` daemons spawned by live /
    // E2E tests. Each test file kills its own engine in `afterAll`,
    // but mid-flight crashes leak; this is the backstop. Filtered
    // by socket path containing `opensquid-` so the user's real
    // engine daemon at `~/.opensquid/loop-engine.sock` is never
    // touched. See test/__util/global-teardown.ts for details.
    globalSetup: ['./test/__util/global-teardown.ts'],
  },
});
