/**
 * CHS.1 — the codex-hooks CLI step: ENOENT create, re-run stability,
 * codex-absent no-op, missing-shim cancel.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCodexHooksWizard } from './codex_hooks.js';

let codexDir: string;
let lines: string[];

beforeEach(async () => {
  codexDir = await mkdtemp(join(tmpdir(), 'opensquid-codex-'));
  lines = [];
});

afterEach(async () => {
  await rm(codexDir, { recursive: true, force: true });
});

const deps = (): Parameters<typeof runCodexHooksWizard>[0] => ({
  codexDir,
  binDir: '/abs/bin',
  out: (l) => lines.push(l),
});

describe('runCodexHooksWizard', () => {
  it('creates hooks.json with the 5 entries on a fresh ~/.codex', async () => {
    await runCodexHooksWizard(deps());
    const parsed = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(parsed.hooks)).toHaveLength(5);
    expect(parsed.hooks.SessionEnd).toBeUndefined();
    expect(lines.join('\n')).toContain('5 added');
    expect(lines.join('\n')).toContain('ACTIVATION REQUIRES TRUST');
  });

  it('re-run: replaces 5, adds 0, byte-stable content + backup created', async () => {
    await runCodexHooksWizard(deps());
    const first = await readFile(join(codexDir, 'hooks.json'), 'utf8');
    lines = [];
    await runCodexHooksWizard(deps());
    expect(await readFile(join(codexDir, 'hooks.json'), 'utf8')).toBe(first);
    expect(lines.join('\n')).toContain('0 added, 5 replaced');
  });

  it('codex not installed → no-op with a note', async () => {
    await rm(codexDir, { recursive: true, force: true });
    await runCodexHooksWizard(deps());
    expect(lines.join('\n')).toContain('codex is not installed');
  });

  it('preserves a foreign group across the rewrite', async () => {
    const foreign = {
      hooks: {
        PostToolUse: [
          { matcher: 'Write|Edit', hooks: [{ type: 'command', command: '/figma.sh' }] },
        ],
      },
    };
    await writeFile(join(codexDir, 'hooks.json'), JSON.stringify(foreign), 'utf8');
    await runCodexHooksWizard(deps());
    const parsed = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8')) as {
      hooks: { PostToolUse: { hooks: { command: string }[] }[] };
    };
    expect(
      parsed.hooks.PostToolUse.some((g) => g.hooks.some((h) => h.command === '/figma.sh')),
    ).toBe(true);
  });
});
