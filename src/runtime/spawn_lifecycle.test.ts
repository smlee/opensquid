/**
 * SUB.2 (T-handoff-nested-session-spam, wg-627effbb2c38) — the shared
 * one-shot spawn lifecycle: SIGTERM at timeout, REF'D grace timer, then
 * process-group SIGKILL; OPENSQUID_SUPERVISED kill-tree marker (outermost
 * helper spawn detaches as group leader, nested spawns join the ancestor's
 * group); OPENSQUID_SUBAGENT hook-policy marker only when markSubagent.
 *
 * Real child processes throughout — the SIGTERM-ignoring fixture is the
 * exact behavior observed live from orphaned `claude -p` reviewers.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { insideSupervisedTree, runOneShotCli } from './spawn_lifecycle.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'opensquid-spawnlc-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  delete process.env.OPENSQUID_SUPERVISED;
});

const timeoutError = (ms: number): Error => new Error(`timeout after ${ms}ms`);

const waitMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('runOneShotCli — basic contracts', () => {
  it('exit 0 → resolves raw stdout (no trim)', async () => {
    const script = join(tmpRoot, 'ok.js');
    await writeFile(script, "process.stdout.write('out \\n');", 'utf8');
    await expect(
      runOneShotCli({
        cli: process.execPath,
        args: [script],
        prompt: '',
        timeoutMs: 10_000,
        markSubagent: false,
        timeoutError,
      }),
    ).resolves.toBe('out \n');
  });

  it('non-zero exit → rejects with the prefixed message', async () => {
    const script = join(tmpRoot, 'fail.js');
    await writeFile(script, "process.stderr.write('boom'); process.exit(3);", 'utf8');
    await expect(
      runOneShotCli({
        cli: process.execPath,
        args: [script],
        prompt: '',
        timeoutMs: 10_000,
        markSubagent: false,
        timeoutError,
        errorPrefix: 'subscription cli ',
      }),
    ).rejects.toThrow('subscription cli exit 3: boom');
  });

  it('spawn failure → rejects with the prefixed message', async () => {
    await expect(
      runOneShotCli({
        cli: join(tmpRoot, 'does-not-exist'),
        args: [],
        prompt: '',
        timeoutMs: 1_000,
        markSubagent: false,
        timeoutError,
      }),
    ).rejects.toThrow(/spawn failed/);
  });
});

describe('runOneShotCli — markers', () => {
  it('markSubagent: child sees SUBAGENT + SUPERVISED', async () => {
    const script = join(tmpRoot, 'env.js');
    await writeFile(
      script,
      'process.stdout.write(`${process.env.OPENSQUID_SUBAGENT}/${process.env.OPENSQUID_SUPERVISED}`);',
      'utf8',
    );
    await expect(
      runOneShotCli({
        cli: process.execPath,
        args: [script],
        prompt: '',
        timeoutMs: 10_000,
        markSubagent: true,
        timeoutError,
      }),
    ).resolves.toBe('1/1');
  });

  it('bridge spawn (markSubagent false): SUPERVISED but NOT SUBAGENT — the spec-audit finding-1 scenario', async () => {
    const script = join(tmpRoot, 'env2.js');
    await writeFile(
      script,
      'process.stdout.write(`${process.env.OPENSQUID_SUBAGENT}/${process.env.OPENSQUID_SUPERVISED}`);',
      'utf8',
    );
    await expect(
      runOneShotCli({
        cli: process.execPath,
        args: [script],
        prompt: '',
        timeoutMs: 10_000,
        markSubagent: false,
        timeoutError,
      }),
    ).resolves.toBe('undefined/1');
  });

  it('insideSupervisedTree reads the exact-"1" marker', () => {
    expect(insideSupervisedTree({ OPENSQUID_SUPERVISED: '1' })).toBe(true);
    expect(insideSupervisedTree({})).toBe(false);
    expect(insideSupervisedTree({ OPENSQUID_SUPERVISED: '0' })).toBe(false);
  });

  it('nested (SUPERVISED already set): child is NOT a group leader (pgid ≠ pid)', async () => {
    process.env.OPENSQUID_SUPERVISED = '1';
    const script = join(tmpRoot, 'pgid.js');
    // A group LEADER has pgid === pid; a non-detached child inherits ours.
    await writeFile(
      script,
      "const{execSync}=require('node:child_process');" +
        'const pgid=execSync(`ps -o pgid= -p ${process.pid}`).toString().trim();' +
        'process.stdout.write(`${process.pid}:${pgid}`);',
      'utf8',
    );
    const out = await runOneShotCli({
      cli: process.execPath,
      args: [script],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
    });
    const [pid, pgid] = out.split(':');
    expect(pid).not.toBe(pgid); // joined OUR group, not its own
  });
});

describe('runOneShotCli — SIGTERM → grace → group SIGKILL', () => {
  it('SIGTERM-ignoring child is dead within grace (the observed orphan class)', async () => {
    const script = join(tmpRoot, 'ignore-term.js');
    await writeFile(
      script,
      "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);",
      'utf8',
    );
    const p = runOneShotCli({
      cli: process.execPath,
      args: [script],
      prompt: '',
      timeoutMs: 400,
      markSubagent: true,
      timeoutError,
      graceMs: 300,
    }).catch((e: unknown) => e as Error);

    // Rejects at the timeout (not after grace).
    const t0 = Date.now();
    const err = await p;
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('timeout after 400ms');

    // The stdout handler captured the pid before the kill; poll it down.
    // (stdout was abandoned at rejection — re-derive the pid via ps over the
    // fixture script name instead.)
    await waitMs(700); // timeout(0 already passed) + grace 300 + margin
    const { execSync } = await import('node:child_process');
    const survivors = execSync(
      `ps -ax -o pid,command | grep 'ignore-term.js' | grep -v grep || true`,
    )
      .toString()
      .trim();
    expect(survivors).toBe('');
  }, 15_000);

  it('group sweep: the grandchild dies with the child', async () => {
    const grand = join(tmpRoot, 'grand.js');
    await writeFile(grand, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", 'utf8');
    const child = join(tmpRoot, 'child-spawner.js');
    await writeFile(
      child,
      "process.on('SIGTERM', () => {});" +
        "const{spawn}=require('node:child_process');" +
        `spawn(process.execPath,['${grand}'],{stdio:'ignore'});` +
        'setInterval(() => {}, 1000);',
      'utf8',
    );
    await runOneShotCli({
      cli: process.execPath,
      args: [child],
      prompt: '',
      timeoutMs: 400,
      markSubagent: true,
      timeoutError,
      graceMs: 300,
    }).catch(() => undefined);

    await waitMs(900);
    const { execSync } = await import('node:child_process');
    const survivors = execSync(
      `ps -ax -o pid,command | grep -E 'grand\\.js|child-spawner\\.js' | grep -v grep || true`,
    )
      .toString()
      .trim();
    expect(survivors).toBe('');
  }, 15_000);

  it('FXK.1: SHORT-LIVED supervisor (the hook-bin shape) — exit handler kills the child the timer cannot', async () => {
    // The 0.5.398 hole class: vitest workers are long-lived, so the timer
    // path always worked IN TESTS while hook bins (which process.exit()
    // milliseconds after the rejection) never fired it. This test runs the
    // BUILT helper inside a real short-lived supervisor process.
    const { pathToFileURL, fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const helperUrl = pathToFileURL(path.resolve(repoRoot, 'dist/runtime/spawn_lifecycle.js')).href;

    const child = join(tmpRoot, 'fxk-child.js');
    await writeFile(
      child,
      "process.on('SIGTERM', () => {});" +
        "require('fs').writeFileSync(process.env.PIDFILE, String(process.pid));" +
        'setInterval(() => {}, 1000);',
      'utf8',
    );
    const pidFile = join(tmpRoot, 'fxk-pid');
    const supervisor = join(tmpRoot, 'fxk-supervisor.mjs');
    await writeFile(
      supervisor,
      `import { runOneShotCli } from '${helperUrl}';\n` +
        `runOneShotCli({ cli: process.execPath, args: ['${child}'], prompt: '', ` +
        `timeoutMs: 300, graceMs: 60000, markSubagent: true, ` +
        `timeoutError: (ms) => new Error('timeout ' + ms) })` +
        `.catch(() => process.exit(2)); // the hook-bin shape: exit AT the rejection\n`,
      'utf8',
    );

    const { spawn: spawnProc } = await import('node:child_process');
    await new Promise<void>((res) => {
      const sup = spawnProc(process.execPath, [supervisor], {
        stdio: 'ignore',
        env: { ...process.env, PIDFILE: pidFile },
      });
      sup.on('close', () => res());
    });
    // graceMs is 60s — if the child dies, it was the EXIT HANDLER, not the timer.
    await waitMs(700);
    const { readFileSync } = await import('node:fs');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* cleanup */
      }
    }
    expect(alive).toBe(false);
  }, 20_000);

  it('FXK.1: exit-listener count returns to baseline across sequential calls (bridge-daemon hygiene)', async () => {
    const baseline = process.listenerCount('exit');
    const script = join(tmpRoot, 'obey2.js');
    await writeFile(script, 'setInterval(() => {}, 1000);', 'utf8');
    for (let i = 0; i < 5; i++) {
      await runOneShotCli({
        cli: process.execPath,
        args: [script],
        prompt: '',
        timeoutMs: 200,
        markSubagent: false,
        timeoutError,
        graceMs: 500,
      }).catch(() => undefined);
    }
    await waitMs(900); // let every closed_late / timer path settle
    expect(process.listenerCount('exit')).toBe(baseline);
  }, 15_000);

  it('SIGTERM-obeying child clears the grace timer (closed_late path — vitest exits promptly)', async () => {
    const script = join(tmpRoot, 'obey-term.js');
    await writeFile(script, 'setInterval(() => {}, 1000);', 'utf8'); // default SIGTERM = die
    const t0 = Date.now();
    await runOneShotCli({
      cli: process.execPath,
      args: [script],
      prompt: '',
      timeoutMs: 300,
      markSubagent: false,
      timeoutError,
      graceMs: 60_000, // a LEAKED ref'd timer at this size would hang the worker — the pass proves clearance
    }).catch(() => undefined);
    // Give 'close' a beat to fire and clear the grace timer.
    await waitMs(500);
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 15_000);
});
