/**
 * Tests for `readSettingsHooks` + `flatten` (G.2).
 *
 * Coverage matches spec test fixtures:
 *   - settings.json with 4 opensquid events → returns 4 entries, all flagged
 *     with opensquidMarker=true, type='command'
 *   - settings.json with a 3rd-party Stop hook → preserved entry with marker=false
 *   - settings.json with D9-guard prompt-type hook on UserPromptSubmit →
 *     returns entry with type='prompt' (so doctor's spawn loop skips it)
 *   - settings.json with matcher field (e.g. "Bash" on PreToolUse) → matcher
 *     propagates onto the parsed entry
 *   - ENOENT → returns [] cleanly (no throw)
 *   - empty settings.json (`{}`) → returns []
 *   - malformed JSON → throws (doctor wraps + reports RED)
 *
 * Parallel-safe: each disk-touching test uses its own tmpdir.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flatten, readSettingsHooks } from './settings-reader.js';

let dir: string;
let settingsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-settings-reader-'));
  settingsPath = join(dir, 'settings.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readSettingsHooks — disk paths', () => {
  it('returns [] when the file does not exist (ENOENT)', async () => {
    const out = await readSettingsHooks(join(dir, 'missing.json'));
    expect(out).toEqual([]);
  });

  it('returns [] for an empty {} settings.json', async () => {
    await writeFile(settingsPath, '{}');
    const out = await readSettingsHooks(settingsPath);
    expect(out).toEqual([]);
  });

  it('throws on malformed JSON (doctor catches and reports RED)', async () => {
    await writeFile(settingsPath, '{not valid json');
    await expect(readSettingsHooks(settingsPath)).rejects.toThrow();
  });

  it('reads + flattens the 4 opensquid events with markers', async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: 'opensquid-hook-pretooluse', '@opensquid': true },
              ],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                { type: 'command', command: 'opensquid-hook-userpromptsubmit', '@opensquid': true },
              ],
            },
          ],
          Stop: [
            { hooks: [{ type: 'command', command: 'opensquid-hook-stop', '@opensquid': true }] },
          ],
          SessionEnd: [
            {
              hooks: [
                { type: 'command', command: 'opensquid-hook-sessionend', '@opensquid': true },
              ],
            },
          ],
        },
      }),
    );
    const out = await readSettingsHooks(settingsPath);
    expect(out).toHaveLength(4);
    for (const entry of out) {
      expect(entry.opensquidMarker).toBe(true);
      expect(entry.type).toBe('command');
      expect(entry.command).toContain('opensquid-hook-');
    }
    expect(out.map((e) => e.event).sort()).toEqual([
      'PreToolUse',
      'SessionEnd',
      'Stop',
      'UserPromptSubmit',
    ]);
  });
});

describe('flatten — pure projection', () => {
  it('returns a 3rd-party Stop hook with marker=false (preserved entry)', () => {
    const out = flatten({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'bun run /home/u/session-summary.ts' }] }],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      event: 'Stop',
      type: 'command',
      command: 'bun run /home/u/session-summary.ts',
      opensquidMarker: false,
    });
  });

  it('preserves D9-guard prompt-type entries with type="prompt"', () => {
    const out = flatten({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'prompt',
                prompt: 'Reminder: check destination alignment',
              },
            ],
          },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      event: 'UserPromptSubmit',
      type: 'prompt',
      command: '',
      prompt: 'Reminder: check destination alignment',
      opensquidMarker: false,
    });
  });

  it('propagates the matcher field (e.g. "Bash" on PreToolUse)', () => {
    const out = flatten({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'opensquid-hook-pretooluse', '@opensquid': true }],
          },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.matcher).toBe('Bash');
  });

  it('flattens mixed opensquid + 3rd-party + prompt entries from the same settings.json', () => {
    const out = flatten({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'opensquid-hook-stop', '@opensquid': true }] },
          { hooks: [{ type: 'command', command: 'bun run ./session.ts' }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'reminder' }] }],
      },
    });
    expect(out).toHaveLength(3);
    const markers = out.map((e) => e.opensquidMarker);
    expect(markers).toEqual([true, false, false]);
    expect(out.find((e) => e.type === 'prompt')?.prompt).toBe('reminder');
  });

  it('returns [] when hooks block is missing or not an object', () => {
    expect(flatten({})).toEqual([]);
    expect(flatten({ hooks: {} })).toEqual([]);
  });

  it('skips groups where hooks array is missing (forward-compat with future shapes)', () => {
    const out = flatten({
      hooks: {
        PreToolUse: [{ matcher: 'Bash' }],
      },
    });
    expect(out).toEqual([]);
  });
});
