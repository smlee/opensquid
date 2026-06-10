/**
 * Tests for `runDoctorHooks` + the shared ownership predicate gate + `printReport` (G.2).
 *
 * Coverage matches spec test fixtures:
 *   - correct opensquid-hook-pretooluse spawn → GREEN (marker present)
 *   - broken `node dist/index.js anti-drift pre-tool-use` (no marker) → RED
 *     with reason mentioning silent no-op
 *   - non-opensquid hook (user's `bun run claude-memory/...`) → SKIPPED with
 *     reason "not opensquid-managed"
 *   - D9-guard prompt-type hook → SKIPPED with reason mentioning non-spawnable
 *   - settings.json doesn't exist → SKIPPED with informational reason
 *   - exit-code semantics: 0 red → returns 0; ≥1 red → returns 1
 *   - predicate coverage: bin names (any path/args) + legacy anti-drift match; lookalikes don't
 *   - probe payload kind matches the bin's normalized event kind label
 *
 * Uses `spawnProbe` injection so tests don't actually spawn anything; the
 * subprocess wiring is exercised by `hooks.bin.integration.test.ts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { printReport, runDoctorHooks, type DoctorResult } from './doctor.js';
import { isOpensquidHookCommand } from '../wizard/settings-writer.js';

let dir: string;
let userPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-doctor-'));
  userPath = join(dir, 'user-settings.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Builds a fake probe that always emits the dispatch marker for the given
 * event kinds — simulates a correctly-wired opensquid hook bin. */
function fakeProbeGreen(kindForCommand: Record<string, string>) {
  return async (command: string, _stdin: string): Promise<{ exitCode: number; stderr: string }> => {
    const kind = kindForCommand[command] ?? 'unknown';
    return Promise.resolve({
      exitCode: 0,
      stderr: `[opensquid-dispatch] event=${kind} rules=0 packs=0\n`,
    });
  };
}

/** Probe that returns NO marker — simulates the G.1 silent-no-op failure. */
const fakeProbeSilent = async (
  _command: string,
  _stdin: string,
): Promise<{ exitCode: number; stderr: string }> => {
  return Promise.resolve({ exitCode: 0, stderr: '' });
};

// T-FIX-WIZARD-HOOK-RECOGNITION: doctor's managed-filter + spawn gate use the
// SHARED ownership predicate (the old local substring regex is deleted).
describe('isOpensquidHookCommand (doctor gate)', () => {
  it('matches opensquid-hook-* bin names', () => {
    expect(isOpensquidHookCommand('opensquid-hook-pretooluse')).toBe(true);
    expect(isOpensquidHookCommand('opensquid-hook-stop')).toBe(true);
    expect(isOpensquidHookCommand('opensquid-hook-sessionend')).toBe(true);
    expect(isOpensquidHookCommand('opensquid-hook-userpromptsubmit')).toBe(true);
  });

  it('matches path-prefixed and argument variants', () => {
    expect(isOpensquidHookCommand('/Users/u/.nvm/bin/opensquid-hook-pretooluse')).toBe(true);
    expect(isOpensquidHookCommand('opensquid-hook-stop --flag')).toBe(true);
  });

  it('matches the legacy "node .../opensquid/dist/index.js anti-drift" shape', () => {
    expect(
      isOpensquidHookCommand('node /home/u/opensquid/dist/index.js anti-drift pre-tool-use'),
    ).toBe(true);
  });

  it('does NOT match unrelated user commands', () => {
    expect(isOpensquidHookCommand('bun run claude-memory/scripts/foo.ts')).toBe(false);
    expect(isOpensquidHookCommand('echo hello')).toBe(false);
    expect(isOpensquidHookCommand('npm run check')).toBe(false);
  });

  it('does NOT match lookalikes the old substring regex would have spawned (declared tightening)', () => {
    expect(isOpensquidHookCommand('opensquid-hook-typo-not-ours')).toBe(false);
    expect(isOpensquidHookCommand('echo opensquid-hook-stop-fake')).toBe(false);
  });
});

describe('runDoctorHooks — settings.json absent', () => {
  it('reports SKIPPED for missing user + project settings (no RED, no GREEN)', async () => {
    const results = await runDoctorHooks({
      userSettingsPath: join(dir, 'no-such-user.json'),
      projectSettingsPath: join(dir, 'no-such-project.json'),
      spawnProbe: fakeProbeSilent,
    });
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.status).toBe('skipped');
    expect(results.every((r) => r.reason.includes('no hooks at'))).toBe(true);
  });
});

describe('runDoctorHooks — green path', () => {
  it('reports GREEN for a correctly-wired opensquid hook bin', async () => {
    await writeFile(
      userPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: 'opensquid-hook-pretooluse', '@opensquid': true },
              ],
            },
          ],
        },
      }),
    );
    const results = await runDoctorHooks({
      userSettingsPath: userPath,
      projectSettingsPath: join(dir, 'no-project.json'),
      spawnProbe: fakeProbeGreen({ 'opensquid-hook-pretooluse': 'tool_call' }),
    });
    const green = results.filter((r) => r.status === 'green');
    expect(green).toHaveLength(1);
    expect(green[0]?.event).toBe('PreToolUse');
    expect(green[0]?.reason).toBe('marker present');
    // FC.5: a managing scope missing the other 5 canonical events → 5 coverage reds.
    expect(results.filter((r) => r.status === 'red')).toHaveLength(5);
  });

  it('reports GREEN for all 6 canonical events when fully wired (no coverage reds)', async () => {
    await writeFile(
      userPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'opensquid-hook-pretooluse' }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'opensquid-hook-userpromptsubmit' }] },
          ],
          Stop: [{ hooks: [{ type: 'command', command: 'opensquid-hook-stop' }] }],
          SessionEnd: [{ hooks: [{ type: 'command', command: 'opensquid-hook-sessionend' }] }],
          PostToolUse: [{ hooks: [{ type: 'command', command: 'opensquid-hook-posttooluse' }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: 'opensquid-hook-sessionstart' }] }],
        },
      }),
    );
    const results = await runDoctorHooks({
      userSettingsPath: userPath,
      projectSettingsPath: join(dir, 'no-project.json'),
      spawnProbe: fakeProbeGreen({
        'opensquid-hook-pretooluse': 'tool_call',
        'opensquid-hook-userpromptsubmit': 'prompt_submit',
        'opensquid-hook-stop': 'stop',
        'opensquid-hook-sessionend': 'session_end',
        'opensquid-hook-posttooluse': 'post_tool_call',
        'opensquid-hook-sessionstart': 'session_start',
      }),
    });
    const real = results.filter((r) => r.event !== '-');
    expect(real).toHaveLength(6);
    expect(real.every((r) => r.status === 'green')).toBe(true);
  });
});

describe('runDoctorHooks — FC.5 canonical coverage', () => {
  it('RED-flags canonical events missing from a scope that manages opensquid hooks', async () => {
    await writeFile(
      userPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'opensquid-hook-pretooluse' }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'opensquid-hook-userpromptsubmit' }] },
          ],
        },
      }),
    );
    const results = await runDoctorHooks({
      userSettingsPath: userPath,
      projectSettingsPath: join(dir, 'no-project.json'),
      spawnProbe: fakeProbeGreen({
        'opensquid-hook-pretooluse': 'tool_call',
        'opensquid-hook-userpromptsubmit': 'prompt_submit',
      }),
    });
    const missing = results.filter(
      (r) => r.status === 'red' && r.reason.includes('not registered'),
    );
    expect(missing.map((r) => r.event).sort()).toEqual([
      'PostToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
    ]);
    expect(missing.every((r) => r.reason.includes('opensquid setup wizard hooks'))).toBe(true);
    expect(printReport(results)).toBeGreaterThan(0); // coverage red → non-zero exit
  });

  it('a scope with NO opensquid-managed hooks gets no coverage reds (project scope optional)', async () => {
    await writeFile(
      userPath,
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo not-opensquid' }] }] },
      }),
    );
    const results = await runDoctorHooks({
      userSettingsPath: userPath,
      projectSettingsPath: join(dir, 'no-project.json'),
      spawnProbe: fakeProbeGreen({}),
    });
    expect(results.filter((r) => r.reason.includes('not registered'))).toHaveLength(0);
  });
});

describe('runDoctorHooks — red path', () => {
  it('reports RED with silent-no-op reason when marker is absent', async () => {
    await writeFile(
      userPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node /home/u/opensquid/dist/index.js anti-drift pre-tool-use',
                },
              ],
            },
          ],
        },
      }),
    );
    const results = await runDoctorHooks({
      userSettingsPath: userPath,
      projectSettingsPath: join(dir, 'no-project.json'),
      spawnProbe: fakeProbeSilent,
    });
    const probed = results.filter((r) => r.reason.includes('marker absent'));
    expect(probed).toHaveLength(1);
    expect(probed[0]?.status).toBe('red');
    expect(probed[0]?.event).toBe('PreToolUse');
    expect(probed[0]?.reason).toMatch(/silent no-op/);
  });

  it('reports RED when spawn throws (timeout, ENOENT, etc.)', async () => {
    await writeFile(
      userPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'opensquid-hook-pretooluse' }] }],
        },
      }),
    );
    const results = await runDoctorHooks({
      userSettingsPath: userPath,
      projectSettingsPath: join(dir, 'no-project.json'),
      spawnProbe: () => Promise.reject(new Error('boom')),
    });
    const real = results.filter((r) => r.event !== '-');
    expect(real[0]?.status).toBe('red');
    expect(real[0]?.reason).toMatch(/spawn failed/);
  });

  it('reports RED when settings.json is malformed', async () => {
    await writeFile(userPath, '{not valid json');
    const results = await runDoctorHooks({
      userSettingsPath: userPath,
      projectSettingsPath: join(dir, 'no-project.json'),
      spawnProbe: fakeProbeSilent,
    });
    const userResults = results.filter((r) => r.scope === 'user');
    expect(userResults).toHaveLength(1);
    expect(userResults[0]?.status).toBe('red');
    expect(userResults[0]?.reason).toMatch(/could not parse/);
  });
});

describe('runDoctorHooks — security gate (skip non-opensquid commands)', () => {
  it('SKIPS a non-opensquid 3rd-party hook command without spawning it', async () => {
    let spawnCount = 0;
    await writeFile(
      userPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'bun run claude-memory/scripts/foo.ts' }] }],
        },
      }),
    );
    const results = await runDoctorHooks({
      userSettingsPath: userPath,
      projectSettingsPath: join(dir, 'no-project.json'),
      spawnProbe: () => {
        spawnCount += 1;
        return Promise.resolve({ exitCode: 0, stderr: '' });
      },
    });
    const real = results.filter((r) => r.event !== '-');
    expect(real).toHaveLength(1);
    expect(real[0]?.status).toBe('skipped');
    expect(real[0]?.reason).toBe('not opensquid-managed');
    expect(spawnCount).toBe(0); // CRITICAL: never spawn non-opensquid commands
  });
});

describe('runDoctorHooks — D9-guard prompt skip', () => {
  it('SKIPS a prompt-type hook (not spawnable)', async () => {
    let spawnCount = 0;
    await writeFile(
      userPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'prompt', prompt: 'Reminder: check destination' }] },
          ],
        },
      }),
    );
    const results = await runDoctorHooks({
      userSettingsPath: userPath,
      projectSettingsPath: join(dir, 'no-project.json'),
      spawnProbe: () => {
        spawnCount += 1;
        return Promise.resolve({ exitCode: 0, stderr: '' });
      },
    });
    const real = results.filter((r) => r.event !== '-');
    expect(real).toHaveLength(1);
    expect(real[0]?.status).toBe('skipped');
    expect(real[0]?.reason).toMatch(/non-spawnable/);
    expect(spawnCount).toBe(0);
  });
});

describe('printReport — exit-code semantics', () => {
  it('returns 0 when no RED results', () => {
    const results: DoctorResult[] = [
      {
        scope: 'user',
        event: 'PreToolUse',
        command: 'opensquid-hook-pretooluse',
        status: 'green',
        reason: '',
      },
      { scope: 'user', event: 'Stop', command: 'opensquid-hook-stop', status: 'green', reason: '' },
    ];
    expect(printReport(results)).toBe(0);
  });

  it('returns N (>0) when N results are RED', () => {
    const results: DoctorResult[] = [
      {
        scope: 'user',
        event: 'PreToolUse',
        command: 'opensquid-hook-pretooluse',
        status: 'red',
        reason: 'no marker',
      },
      { scope: 'user', event: 'Stop', command: 'opensquid-hook-stop', status: 'green', reason: '' },
      {
        scope: 'user',
        event: 'SessionEnd',
        command: 'opensquid-hook-sessionend',
        status: 'red',
        reason: 'spawn',
      },
    ];
    expect(printReport(results)).toBe(2);
  });
});
