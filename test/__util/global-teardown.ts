/**
 * Vitest globalSetup — safety net for stray `loop-engine` daemons
 * spawned by live / E2E tests.
 *
 * Vitest's `globalSetup` runs once before the full test run; its
 * returned function runs once after. We do nothing on setup and use
 * the teardown half to `pkill` any stray engine daemons whose socket
 * path matches `opensquid-` (i.e. were spawned from a test tmpdir).
 *
 * Each live test SHOULD kill its spawned engine via
 * `test/__util/kill-engine.ts` in `afterAll`, but failure modes leak:
 *   - test killed mid-flight (ctrl-c, OOM) before afterAll ran
 *   - pidfile unreadable / never written
 *   - the engine spawned but the test crashed before recording the home
 *
 * The path filter `opensquid-` matches the tmpdir names produced by
 * `mkdtempSync(join(tmpdir(), 'opensquid-...'))` — the only places
 * live tests spawn engines. The user's real engine daemon
 * (`~/.opensquid/loop-engine.sock`) is NOT matched.
 *
 * Silent on no-match (typical case — no leaks). Logs to stderr only
 * when it actually kills something so the user knows leaks happened.
 *
 * No-op on Windows (pkill unavailable; engine doesn't run on Windows
 * yet per T.8.H.01 anyway).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// eslint-disable-next-line import/no-default-export -- vitest globalSetup requires a default export
export default function setup(): () => Promise<void> {
  return async function teardown(): Promise<void> {
    if (process.platform === 'win32') return;

    try {
      // `pkill -f <pattern>` matches against the full command line.
      // We pass a regex anchored to the spawn shape; pkill exits 1 if
      // no processes matched, which is the typical case.
      const pattern = 'loop-engine serve --socket .*opensquid-';
      await execFileAsync('pkill', ['-f', pattern]);
      // If we got here, pkill matched + signaled at least one process.
      process.stderr.write(
        `[vitest globalSetup teardown] killed stray loop-engine daemon(s) matching: ${pattern}\n`,
      );
    } catch (e) {
      // exit code 1 == nothing matched (clean run, the common case).
      // Any other exit code likely means pkill isn't installed; ignore.
      const code = (e as { code?: number } | undefined)?.code;
      if (code !== undefined && code !== 1) {
        process.stderr.write(
          `[vitest globalSetup teardown] pkill exited with code ${String(code)}; ignoring.\n`,
        );
      }
    }
  };
}
