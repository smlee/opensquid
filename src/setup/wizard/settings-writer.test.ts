/**
 * Tests for `writeOpensquidHooks` and `projectOpensquidHooks` (G.1 — Part B).
 *
 * Coverage matches spec §"Test fixtures":
 *   - empty settings.json → writes 4 events with @opensquid markers
 *   - settings.json with user's session-summary on Stop → preserved verbatim
 *   - settings.json with legacy `node dist/index.js anti-drift <event>` → detected + removed
 *   - settings.json with existing @opensquid: true entry → recognised as ours, replaced fresh
 *   - running twice produces byte-identical output (idempotency)
 *   - D9-guard `prompt` hook on Stop → preserved verbatim
 *   - settings.json doesn't exist → .bak is `{}`, output has just the opensquid block
 *
 * Each test uses its own tmpdir; no shared mutable state — parallel-safe.
 */

import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LEGACY_OPENSQUID_PATTERN,
  OPENSQUID_BIN_FOR_EVENT,
  projectOpensquidHooks,
  writeOpensquidHooks,
} from './settings-writer.js';

let dir: string;
let settingsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-settings-writer-'));
  settingsPath = join(dir, 'settings.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readJson(p: string): Promise<unknown> {
  return JSON.parse(await readFile(p, 'utf8')) as unknown;
}

describe('writeOpensquidHooks — empty / nonexistent settings.json', () => {
  it('creates the file with one opensquid hook entry per event when settings.json does not exist', async () => {
    const result = await writeOpensquidHooks(settingsPath);
    expect(result.added).toBe(Object.keys(OPENSQUID_BIN_FOR_EVENT).length);
    expect(result.replaced).toBe(0);
    expect(result.preserved).toBe(0);

    const out = (await readJson(settingsPath)) as {
      hooks: Record<string, { hooks: { command: string; '@opensquid'?: boolean }[] }[]>;
    };
    for (const event of Object.keys(OPENSQUID_BIN_FOR_EVENT)) {
      expect(out.hooks[event]).toHaveLength(1);
      const inner = out.hooks[event]?.[0]?.hooks?.[0];
      expect(inner?.command).toBe(
        OPENSQUID_BIN_FOR_EVENT[event as keyof typeof OPENSQUID_BIN_FOR_EVENT],
      );
      expect(inner?.['@opensquid']).toBe(true);
    }
  });

  it('writes a .bak containing an empty object when settings.json did not exist', async () => {
    await writeOpensquidHooks(settingsPath);
    const bak = await readJson(`${settingsPath}.bak`);
    expect(bak).toEqual({});
  });

  it('produces a settings.json that has just the opensquid hooks block (no spurious keys)', async () => {
    await writeOpensquidHooks(settingsPath);
    const out = (await readJson(settingsPath)) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['hooks']);
  });
});

describe('writeOpensquidHooks — preserves third-party entries', () => {
  it("preserves the user's `bun run session-summary.ts` Stop hook", async () => {
    const userHook = {
      matcher: '.*',
      hooks: [
        {
          type: 'command',
          command: 'bun run /Users/USER/claude-memory/scripts/session-summary.ts',
        },
      ],
    };
    await writeFile(settingsPath, JSON.stringify({ hooks: { Stop: [userHook] } }, null, 2), 'utf8');

    const result = await writeOpensquidHooks(settingsPath);
    expect(result.preserved).toBe(1); // the user's Stop hook
    expect(result.added).toBe(Object.keys(OPENSQUID_BIN_FOR_EVENT).length);

    const out = (await readJson(settingsPath)) as {
      hooks: { Stop: { hooks: { command: string }[]; matcher?: string }[] };
    };
    // User's hook is first (preserved); opensquid's appended.
    expect(out.hooks.Stop).toHaveLength(2);
    expect(out.hooks.Stop[0]).toEqual(userHook);
    expect(out.hooks.Stop[1]?.hooks?.[0]?.command).toBe('opensquid-hook-stop');
  });

  it('preserves the D9-guard inline prompt hook on Stop (no @opensquid marker, type=prompt)', async () => {
    const promptHook = {
      hooks: [
        {
          type: 'prompt',
          prompt: 'D9-guard prompt text here',
          model: 'claude-haiku-4-5',
        },
      ],
    };
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [promptHook] } }, null, 2),
      'utf8',
    );

    await writeOpensquidHooks(settingsPath);

    const out = (await readJson(settingsPath)) as {
      hooks: { Stop: { hooks: { type: string; prompt?: string; command?: string }[] }[] };
    };
    // D9-guard preserved verbatim, opensquid appended.
    expect(out.hooks.Stop).toHaveLength(2);
    expect(out.hooks.Stop[0]).toEqual(promptHook);
    expect(out.hooks.Stop[1]?.hooks?.[0]?.command).toBe('opensquid-hook-stop');
  });
});

describe('writeOpensquidHooks — legacy detection + replacement', () => {
  it('detects legacy `node .../dist/index.js anti-drift <event>` and replaces it', async () => {
    const legacy = {
      hooks: [
        {
          type: 'command',
          command: 'node /Users/USER/projects/opensquid/dist/index.js anti-drift pre-tool-use',
        },
      ],
    };
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { PreToolUse: [legacy] } }, null, 2),
      'utf8',
    );

    const result = await writeOpensquidHooks(settingsPath);
    expect(result.replaced).toBe(1);

    const out = (await readJson(settingsPath)) as {
      hooks: { PreToolUse: { hooks: { command: string; '@opensquid'?: boolean }[] }[] };
    };
    expect(out.hooks.PreToolUse).toHaveLength(1);
    const cmd = out.hooks.PreToolUse[0]?.hooks?.[0];
    expect(cmd?.command).toBe('opensquid-hook-pretooluse');
    expect(cmd?.['@opensquid']).toBe(true);
  });

  it('recognises an existing @opensquid: true entry as ours and replaces it (single fresh entry)', async () => {
    const existing = {
      hooks: [
        {
          type: 'command',
          command: 'opensquid-hook-pretooluse',
          '@opensquid': true,
        },
      ],
    };
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { PreToolUse: [existing] } }, null, 2),
      'utf8',
    );

    await writeOpensquidHooks(settingsPath);

    const out = (await readJson(settingsPath)) as {
      hooks: { PreToolUse: unknown[] };
    };
    // Idempotent: one entry in, one entry out.
    expect(out.hooks.PreToolUse).toHaveLength(1);
  });
});

describe('writeOpensquidHooks — idempotency', () => {
  it('running the writer twice produces byte-identical output', async () => {
    // Seed with a mix of legacy + user + D9-guard so the first pass has
    // real work to do (replace + preserve + add).
    const seed = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node /abs/opensquid/dist/index.js anti-drift pre-tool-use',
              },
            ],
          },
        ],
        Stop: [
          {
            matcher: '.*',
            hooks: [{ type: 'command', command: 'bun run /scripts/session-summary.ts' }],
          },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(seed, null, 2), 'utf8');

    await writeOpensquidHooks(settingsPath);
    const first = await readFile(settingsPath, 'utf8');

    await writeOpensquidHooks(settingsPath);
    const second = await readFile(settingsPath, 'utf8');

    expect(first).toBe(second);
  });
});

describe('projectOpensquidHooks — pure-function projection', () => {
  it('does not mutate the input object', () => {
    const input = { hooks: { PreToolUse: [] } };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    projectOpensquidHooks(input);
    expect(input).toEqual(snapshot);
  });

  it('handles a totally-empty input (no hooks key)', () => {
    const { output, added, replaced, preserved } = projectOpensquidHooks({});
    expect(added).toBe(Object.keys(OPENSQUID_BIN_FOR_EVENT).length);
    expect(replaced).toBe(0);
    expect(preserved).toBe(0);
    expect(Object.keys(output.hooks ?? {})).toEqual([
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'Stop',
      'SessionEnd',
      'SessionStart',
    ]);
  });
});

// T-HANDOFF-HARDENING HH6.1 — SessionStart registration.
describe('writeOpensquidHooks — SessionStart (HH6.1)', () => {
  it('emits a SessionStart group with the opensquid bin + @opensquid marker', async () => {
    await writeOpensquidHooks(settingsPath);
    const out = (await readJson(settingsPath)) as {
      hooks: Record<string, { hooks: { command: string; '@opensquid'?: boolean }[] }[]>;
    };
    expect(out.hooks.SessionStart).toHaveLength(1);
    const inner = out.hooks.SessionStart?.[0]?.hooks?.[0];
    expect(inner?.command).toBe('opensquid-hook-sessionstart');
    expect(inner?.['@opensquid']).toBe(true);
  });

  it("preserves a user's third-party SessionStart hook and appends opensquid's", async () => {
    const userHook = {
      hooks: [{ type: 'command', command: 'bun run /scripts/my-session-start.ts' }],
    };
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { SessionStart: [userHook] } }, null, 2),
      'utf8',
    );

    await writeOpensquidHooks(settingsPath);

    const out = (await readJson(settingsPath)) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    expect(out.hooks.SessionStart).toHaveLength(2);
    expect(out.hooks.SessionStart[0]).toEqual(userHook);
    expect(out.hooks.SessionStart[1]?.hooks?.[0]?.command).toBe('opensquid-hook-sessionstart');
  });
});

describe('LEGACY_OPENSQUID_PATTERN', () => {
  it('matches the broken `node .../opensquid/dist/index.js anti-drift <event>` shape', () => {
    expect(
      LEGACY_OPENSQUID_PATTERN.test(
        'node /Users/USER/projects/opensquid/dist/index.js anti-drift pre-tool-use',
      ),
    ).toBe(true);
    expect(LEGACY_OPENSQUID_PATTERN.test('node /opt/opensquid/dist/index.js anti-drift stop')).toBe(
      true,
    );
  });

  it('does NOT match unrelated commands that happen to mention opensquid', () => {
    // A user-authored audit script that references "opensquid" must NOT
    // be wiped by the wizard.
    expect(LEGACY_OPENSQUID_PATTERN.test('node /Users/USER/my-opensquid-audit.js')).toBe(false);
    expect(LEGACY_OPENSQUID_PATTERN.test('bun run /scripts/session-summary.ts')).toBe(false);
  });
});
