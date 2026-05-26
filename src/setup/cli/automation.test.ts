/**
 * Tests for `opensquid automation on|off|status` CLI verb group (G.12).
 *
 * Coverage:
 *   - `on`     writes the flag file under OPENSQUID_HOME/sessions/<id>/
 *   - `off`    clears the flag (and is a no-op on a missing flag)
 *   - `status` exits 0 when flag is set, 1 when fully off
 *   - `status` reports env-source when OPENSQUID_AUTOMATION=1 (even no flag)
 *   - `--session-id <id>` takes precedence over env / random fallback
 *   - Random uuid fallback triggers when neither flag nor env id present
 *     (stderr advisory carries the generated id)
 *
 * Pattern mirrors `cache.test.ts`: in-memory io capture, `exitOverride()`,
 * `withExit` saves + restores process.exitCode so the verb's exit-1 path
 * doesn't poison subsequent tests.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { automationFlagPath } from '../../runtime/automation_state.js';

import { registerAutomation } from './automation.js';

let tempHome: string;
let priorHome: string | undefined;
let priorAutomationEnv: string | undefined;
let priorSessionEnv: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorAutomationEnv = process.env.OPENSQUID_AUTOMATION;
  priorSessionEnv = process.env.OPENSQUID_SESSION_ID;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-automation-cli-test-'));
  process.env.OPENSQUID_HOME = tempHome;
  delete process.env.OPENSQUID_AUTOMATION;
  delete process.env.OPENSQUID_SESSION_ID;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorAutomationEnv === undefined) delete process.env.OPENSQUID_AUTOMATION;
  else process.env.OPENSQUID_AUTOMATION = priorAutomationEnv;
  if (priorSessionEnv === undefined) delete process.env.OPENSQUID_SESSION_ID;
  else process.env.OPENSQUID_SESSION_ID = priorSessionEnv;
  await rm(tempHome, { recursive: true, force: true });
});

interface CapturedIo {
  stdout: string;
  stderr: string;
}

function build(deps: Parameters<typeof registerAutomation>[1] = {}): {
  program: Command;
  io: CapturedIo;
} {
  const io: CapturedIo = { stdout: '', stderr: '' };
  const program = new Command().name('opensquid').exitOverride();
  registerAutomation(program, {
    stdout: (s) => {
      io.stdout += s;
    },
    stderr: (s) => {
      io.stderr += s;
    },
    randomSessionId: () => 'rand-fallback-uuid',
    ...deps,
  });
  return { program, io };
}

async function withExit(body: () => Promise<void>): Promise<number> {
  const prior = process.exitCode;
  process.exitCode = 0;
  try {
    await body();
    return Number(process.exitCode ?? 0);
  } finally {
    process.exitCode = prior;
  }
}

const argv = (...args: string[]): string[] => ['node', 'cli', 'automation', ...args];

describe('opensquid automation on', () => {
  it('writes the flag file at <home>/sessions/<id>/automation.flag', async () => {
    const { program, io } = build();
    await program.parseAsync(argv('on', '--session-id', 'sess-on'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('automation: on');
    expect(io.stdout).toContain('sess-on');
    const st = await stat(automationFlagPath('sess-on'));
    expect(st.isFile()).toBe(true);
  });

  it('honors OPENSQUID_SESSION_ID env var when --session-id omitted', async () => {
    process.env.OPENSQUID_SESSION_ID = 'env-sid';
    const { program, io } = build();
    await program.parseAsync(argv('on'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('env-sid');
    const st = await stat(automationFlagPath('env-sid'));
    expect(st.isFile()).toBe(true);
  });

  it('resolves from the .current-session pointer when --session-id + env absent', async () => {
    // The UserPromptSubmit hook records the live session id here; the CLI must
    // target it (not a fresh random) so on/off line up with what the hooks key on.
    const { program, io } = build({ readCurrentSession: () => Promise.resolve('live-sid') });
    await program.parseAsync(argv('on'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('live-sid');
    const st = await stat(automationFlagPath('live-sid'));
    expect(st.isFile()).toBe(true);
  });

  it('falls back to a random uuid + stderr advisory when no id source present', async () => {
    // No --session-id, no env, no live pointer → random fallback.
    const { program, io } = build({ readCurrentSession: () => Promise.resolve(null) });
    await program.parseAsync(argv('on'));
    expect(io.stderr).toContain('rand-fallback-uuid');
    expect(io.stdout).toContain('rand-fallback-uuid');
  });

  it('prefers --session-id over the .current-session pointer', async () => {
    const { program, io } = build({ readCurrentSession: () => Promise.resolve('live-sid') });
    await program.parseAsync(argv('on', '--session-id', 'explicit-sid'));
    expect(io.stdout).toContain('explicit-sid');
    expect(io.stdout).not.toContain('live-sid');
  });
});

describe('opensquid automation off', () => {
  it('clears the flag for an existing session', async () => {
    const { program: pOn } = build();
    await pOn.parseAsync(argv('on', '--session-id', 'sess-off'));
    const { program: pOff, io } = build();
    await pOff.parseAsync(argv('off', '--session-id', 'sess-off'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('automation: off');
    await expect(stat(automationFlagPath('sess-off'))).rejects.toThrow();
  });

  it('is a no-op on a session that was never flagged', async () => {
    const { program, io } = build();
    await program.parseAsync(argv('off', '--session-id', 'never-flagged'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('automation: off');
  });
});

describe('opensquid automation status', () => {
  it('exits 0 and reports source=flag when flag set', async () => {
    const { program: pOn } = build();
    await pOn.parseAsync(argv('on', '--session-id', 'sess-status'));

    const exit = await withExit(async () => {
      const { program, io } = build();
      await program.parseAsync(argv('status', '--session-id', 'sess-status'));
      expect(io.stdout).toContain('automation: on');
      expect(io.stdout).toContain('source=flag');
    });
    expect(exit).toBe(0);
  });

  it('exits 0 and reports source=env when OPENSQUID_AUTOMATION=1 (no flag needed)', async () => {
    process.env.OPENSQUID_AUTOMATION = '1';
    const exit = await withExit(async () => {
      const { program, io } = build();
      await program.parseAsync(argv('status', '--session-id', 'sess-env'));
      expect(io.stdout).toContain('automation: on');
      expect(io.stdout).toContain('source=env');
    });
    expect(exit).toBe(0);
  });

  it('exits 1 when neither env nor flag is set', async () => {
    const exit = await withExit(async () => {
      const { program, io } = build();
      await program.parseAsync(argv('status', '--session-id', 'sess-off'));
      expect(io.stdout).toContain('automation: off');
    });
    expect(exit).toBe(1);
  });
});
