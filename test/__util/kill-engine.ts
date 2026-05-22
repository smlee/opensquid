/**
 * Test-side helper for tearing down a real `loop-engine` daemon spawned
 * during a live / E2E test. Reads the pidfile under the test's
 * `OPENSQUID_HOME`, sends SIGTERM, waits a short grace, and cleans up
 * the socket + pidfile if the engine didn't already unlink them.
 *
 * Used by:
 *   - src/engine/client.live.test.ts       (live binary round-trip)
 *   - test/e2e/wedge_gate.test.ts          (wedge gate block-only E2E)
 *   - test/live/loop-engine-rag-live.test.ts (live RAG integration)
 *
 * Best-effort throughout — never throws. A leftover daemon is
 * preferable to a flaky test failure on teardown.
 *
 * The globalTeardown script (`test/__util/global-teardown.ts`) is the
 * belt-and-suspenders backstop for any engine that escaped this helper
 * (e.g. test killed mid-flight, pidfile unreadable, etc.).
 */

import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const ENGINE_TEARDOWN_GRACE_MS = 500;

/**
 * Kill the loop-engine daemon whose pidfile + socket live under
 * `home/loop-engine.{pid,sock}`. No-op if neither file exists.
 *
 * Safe to call from any test's `afterAll` — handles every failure
 * mode (missing pidfile, malformed pidfile, ESRCH already-dead pid,
 * EPERM on signal, etc.) silently.
 */
export async function killEngineByPidfile(home: string): Promise<void> {
  if (!home) return;
  const pidPath = join(home, 'loop-engine.pid');
  const sockPath = join(home, 'loop-engine.sock');

  if (existsSync(pidPath)) {
    try {
      const raw = (await readFile(pidPath, 'utf8')).trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGTERM');
          // Engine SHOULD unlink socket + pidfile itself on SIGTERM.
          // Wait briefly to give it a chance before we step in.
          await new Promise<void>((r) => setTimeout(r, ENGINE_TEARDOWN_GRACE_MS));
        } catch {
          // ESRCH (pid gone) / EPERM (not ours) — fall through to cleanup.
        }
      }
    } catch {
      // Pidfile unreadable / malformed — fall through to cleanup.
    }
  }

  // Defense-in-depth: unlink the socket + pidfile if the engine didn't.
  // existsSync gates so we don't churn ENOENT noise.
  if (existsSync(sockPath)) {
    await unlink(sockPath).catch(() => undefined);
  }
  if (existsSync(pidPath)) {
    await unlink(pidPath).catch(() => undefined);
  }
}
