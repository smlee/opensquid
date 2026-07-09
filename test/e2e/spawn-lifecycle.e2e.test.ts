/**
 * T-spawn-lifecycle-hermetic-tests SLH.3 (wg-23fd463ab434) — the ONE genuine
 * OS-behavior a fake seam cannot prove: a real detached grandchild is actually
 * REAPED by the group SIGKILL (`process.kill(-pid,'SIGKILL')`), not merely that
 * the signal was issued. The always-on unit suite (spawn_lifecycle.test.ts) is
 * fully hermetic; this real-process + temp-fixture check is isolated to the
 * opt-in e2e job (E2E=1), off the always-on path — so it can NEVER re-introduce
 * the timing flake (`waitMs` racing a real spawn-chain) into `pnpm test`.
 *
 * Gated exactly like drift-prevention.e2e.test.ts:59-64 — COLLECTED by
 * `pnpm test` (matches test/**\/*.test.ts) but SELF-SKIPS when E2E !== '1'.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runOneShotCli } from '../../src/runtime/spawn_lifecycle.js';

const SKIP_E2E = process.env.E2E !== '1'; // mirrors drift-prevention.e2e.test.ts:59 — collected but self-skips

describe.skipIf(SKIP_E2E)(
  'spawn_lifecycle e2e — real group SIGKILL reaps a detached grandchild',
  () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'opensquid-spawnlc-e2e-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
      delete process.env.OPENSQUID_SUPERVISED;
    });

    it('the grandchild PID is actually dead after grace → process.kill(-pid) (OS-honored, not just issued)', async () => {
      const gpidFile = join(dir, 'gpid');
      const grand = join(dir, 'grand.js');
      await writeFile(
        grand,
        "process.on('SIGTERM', () => {});" +
          "require('fs').writeFileSync(process.env.GPIDFILE, String(process.pid));" +
          'setInterval(() => {}, 1000);',
        'utf8',
      );
      const child = join(dir, 'child.js');
      await writeFile(
        child,
        "process.on('SIGTERM', () => {});" +
          "const{spawn}=require('node:child_process');" +
          `spawn(process.execPath,[${JSON.stringify(grand)}],{stdio:'ignore',env:{...process.env}});` +
          'setInterval(() => {}, 1000);',
        'utf8',
      );

      await runOneShotCli({
        cli: process.execPath,
        args: [child],
        prompt: '',
        timeoutMs: 400,
        markSubagent: true,
        timeoutError: (ms) => new Error(`timeout ${ms}`),
        graceMs: 300,
        env: { GPIDFILE: gpidFile },
      }).catch(() => undefined);

      await new Promise((r) => setTimeout(r, 900)); // opt-in e2e MAY wall-clock wait — timing-tolerant, off the always-on path

      const gpid = Number(await readFile(gpidFile, 'utf8'));
      let alive = true;
      try {
        process.kill(gpid, 0);
      } catch {
        alive = false;
      }
      if (alive) {
        try {
          process.kill(gpid, 'SIGKILL'); // don't leak an orphan on the runner if the assertion is about to fail
        } catch {
          /* cleanup */
        }
      }
      expect(alive).toBe(false); // the OS actually reaped the detached grandchild via the group SIGKILL
    }, 20_000);
  },
);
