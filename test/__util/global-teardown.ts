/**
 * Vitest globalSetup — two safety nets that run for the whole test pool:
 *
 * 1. T-ASG6 ASG6.1 (2026-05-29) — DEFENSIVE OPENSQUID_HOME ISOLATION.
 *    At setup time, point `OPENSQUID_HOME` + `LOOP_HOME` at a run-wide
 *    tempdir so any test that calls a production function reading those
 *    paths can't touch the dev's real `~/.opensquid/`. Per-test
 *    isolation (ASG.1 + ASG5.1) still works on top of this — each test
 *    that mkdtemp's its own tempHome overrides the run-level one for the
 *    duration of that test. The defense is layered. Restored at teardown.
 *
 *    Caveat: the live `~/.opensquid/.current-session` contamination the
 *    user observed during POSTPUSH.1 (`3c7ede12-...`) turned out to be a
 *    CONCURRENT CLAUDE CODE SESSION racing on the pointer via the
 *    PreToolUse hook — not a test bug. ASG6.1 ships the test-side
 *    defense; the multi-session race is queued as T-MULTISESSION
 *    (bigger architectural fix).
 *
 * 2. Stray `loop-engine` daemon cleanup. At teardown time, `pkill` any
 *    engines whose socket path matches `opensquid-` (i.e. spawned from
 *    a test tmpdir). Each live test SHOULD kill its spawned engine via
 *    `test/__util/kill-engine.ts` in `afterAll`, but failure modes leak:
 *      - test killed mid-flight (ctrl-c, OOM) before afterAll ran
 *      - pidfile unreadable / never written
 *      - the engine spawned but the test crashed before recording the home
 *    The path filter `opensquid-` matches the tmpdir names produced by
 *    `mkdtempSync(join(tmpdir(), 'opensquid-...'))` — the only places
 *    live tests spawn engines. The user's real engine daemon
 *    (`~/.opensquid/loop-engine.sock`) is NOT matched.
 *    Silent on no-match. No-op on Windows (pkill unavailable).
 */

import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// eslint-disable-next-line import/no-default-export -- vitest globalSetup requires a default export
export default function setup(): () => Promise<void> {
  // T-ASG6 ASG6.1 — lock OPENSQUID_HOME for the whole run. Captured in this
  // closure + restored in the returned teardown.
  const priorOpensquidHome = process.env.OPENSQUID_HOME;
  const priorLoopHome = process.env.LOOP_HOME;
  const runtimeHome = mkdtempSync(join(tmpdir(), 'opensquid-vitest-run-'));
  process.env.OPENSQUID_HOME = runtimeHome;
  process.env.LOOP_HOME = runtimeHome;
  process.stderr.write(`[vitest globalSetup] OPENSQUID_HOME=${runtimeHome}\n`);

  return async function teardown(): Promise<void> {
    // Restore env BEFORE rm in case rm fails — env restoration is more
    // important than tempdir cleanup (vitest's OS-level cleanup is fallback).
    if (priorOpensquidHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorOpensquidHome;
    if (priorLoopHome === undefined) delete process.env.LOOP_HOME;
    else process.env.LOOP_HOME = priorLoopHome;
    await rm(runtimeHome, { recursive: true, force: true }).catch(() => undefined);
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
