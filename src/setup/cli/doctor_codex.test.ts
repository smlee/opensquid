/**
 * CHS.1 — doctor checkCodexHooks: absent=INFO, present-with-entries=GREEN,
 * present-empty=INFO, malformed=RED; the trust note always rides.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkCodexHooks } from './doctor.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-doctor-codex-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkCodexHooks', () => {
  it('absent file → INFO (codex optional)', async () => {
    const lines = await checkCodexHooks(join(dir, 'hooks.json'));
    expect(lines[0]).toContain('[INFO]');
    expect(lines[0]).toContain('not installed');
  });

  it('marked entries → GREEN + the trust note', async () => {
    const p = join(dir, 'hooks.json');
    await writeFile(
      p,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: '/x/opensquid-hook-stop', '@opensquid': true }] },
          ],
        },
      }),
      'utf8',
    );
    const lines = await checkCodexHooks(p);
    expect(lines[0]).toContain('[GREEN]');
    expect(lines[0]).toContain('1 opensquid hook entry');
    expect(lines[1]).toContain('/hooks');
  });

  it('present but no opensquid entries → INFO', async () => {
    const p = join(dir, 'hooks.json');
    await writeFile(
      p,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/y.sh' }] }] } }),
      'utf8',
    );
    const lines = await checkCodexHooks(p);
    expect(lines[0]).toContain('[INFO]');
  });

  it('malformed JSON → RED', async () => {
    const p = join(dir, 'hooks.json');
    await writeFile(p, '{ nope', 'utf8');
    const lines = await checkCodexHooks(p);
    expect(lines[0]).toContain('[RED]');
  });
});
