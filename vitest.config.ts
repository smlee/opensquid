import { defineConfig } from 'vitest/config';

/**
 * Vitest config — scopes default test discovery to src/ + test/ + scripts/.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // Cap parallelism: under full-core load, chokidar/file_watcher + spawn
    // SIGTERM timing tests flake (events never fire, kill paths exceed 1s).
    // Half the cores keeps the suite honest without starving the FS watcher.
    maxWorkers: '50%',
    // Safety net for stray `loop-engine` daemons spawned by live /
    // E2E tests. Each test file kills its own engine in `afterAll`,
    // but mid-flight crashes leak; this is the backstop. Filtered
    // by socket path containing `opensquid-` so the user's real
    // engine daemon at `~/.opensquid/loop-engine.sock` is never
    // touched. See test/__util/global-teardown.ts for details.
    globalSetup: ['./test/__util/global-teardown.ts'],
  },
});
