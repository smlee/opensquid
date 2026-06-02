/**
 * T-PACK-FSM-STANDARDIZATION slice B — guards_compiler tests.
 *
 * The golden test is the load-bearing one: it proves a `guard` desugars to the
 * EXACT `ProcessStep[]` the `git` skill hand-writes today — so adopting guards
 * is behavior-preserving and the runtime interpreter is unchanged.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileGuards } from './guards_compiler.js';
import { loadPack } from './loader.js';
import { Guard } from './schemas/manifest.js';

const AMEND_PATTERN = '(?:^|[;&|\\n(])\\s*git\\s+commit\\b[^\\n]*\\s--amend\\b';

describe('compileGuards', () => {
  it('GOLDEN: a detect→verdict guard desugars byte-identically to the hand-written git rule', () => {
    const guard = Guard.parse({
      name: 'never-amend',
      on: 'tool_call',
      detect: {
        call: 'match_command',
        args: { pattern: AMEND_PATTERN, target: 'tool_args.command' },
      },
      as: 'hit',
      when: 'hit',
      level: 'block',
      message: 'BLOCKED: git commit --amend violates never-amend.',
    });
    const res = compileGuards('git', [guard]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.skill.name).toBe('git/guards');
    expect(res.skill.rules).toHaveLength(1);
    const rule = res.skill.rules[0]!;
    expect(rule.id).toBe('guard:never-amend');
    expect(rule.kind).toBe('track_check');
    // The exact two-step process a hand-authored rule writes today:
    expect((rule as { process: unknown }).process).toEqual([
      {
        call: 'match_command',
        args: { pattern: AMEND_PATTERN, target: 'tool_args.command' },
        as: 'hit',
      },
      {
        call: 'verdict',
        if: 'hit',
        args: { level: 'block', message: 'BLOCKED: git commit --amend violates never-amend.' },
      },
    ]);
  });

  it('check-only guard (no detect) compiles to a single verdict step (the verify_gate shape)', () => {
    const guard = Guard.parse({
      name: 'check-only',
      when: 'contains(tool_args.command, "rm -rf")',
      level: 'warn',
      message: 'careful',
    });
    const res = compileGuards('p', [guard]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.skill.rules[0] as { process: unknown[] }).process).toEqual([
      {
        call: 'verdict',
        if: 'contains(tool_args.command, "rm -rf")',
        args: { level: 'warn', message: 'careful' },
      },
    ]);
  });

  it('a guard whose `when` fails to parse is collected as an error (not silently skipped)', () => {
    const guard = Guard.parse({ name: 'bad', when: 'hit &&', level: 'block', message: 'x' });
    const res = compileGuards('p', [guard]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.guardName).toBe('bad');
    expect(res.errors[0]?.message).toMatch(/failed to parse/);
  });

  it('empty guards → ok with a zero-rule skill (caller filters)', () => {
    const res = compileGuards('p', []);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skill.rules).toHaveLength(0);
  });

  it('triggers are the deduped set of each guard `on`', () => {
    const a = Guard.parse({
      name: 'a',
      on: 'tool_call',
      when: 'true',
      level: 'warn',
      message: 'm',
    });
    const b = Guard.parse({ name: 'b', on: 'stop', when: 'true', level: 'warn', message: 'm' });
    const c = Guard.parse({
      name: 'c',
      on: 'tool_call',
      when: 'true',
      level: 'warn',
      message: 'm',
    });
    const res = compileGuards('p', [a, b, c]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const kinds = res.skill.triggers.map((t) => t.kind).sort();
    expect(kinds).toEqual(['stop', 'tool_call']);
  });
});

describe('loadPack — guards synthetic skill integration', () => {
  it('a manifest `guards:` block becomes the synthetic <pack>/guards skill', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guards-pack-'));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'manifest.yaml'),
        [
          'name: gp',
          'version: 0.1.0',
          'scope: workflow',
          'goal: test guards',
          'guards:',
          '  - name: no-rm-rf',
          '    on: tool_call',
          '    detect:',
          '      call: match_command',
          "      args: { pattern: 'rm -rf', target: tool_args.command }",
          '    as: hit',
          '    when: hit',
          '    level: block',
          '    message: blocked rm -rf',
        ].join('\n') + '\n',
        'utf8',
      );
      const pack = await loadPack(dir);
      const synthetic = pack.skills.find((s) => s.name === 'gp/guards');
      expect(synthetic).toBeDefined();
      expect(synthetic!.rules).toHaveLength(1);
      expect(synthetic!.rules[0]!.id).toBe('guard:no-rm-rf');
      // raw guards hoisted onto Pack for audit parity with verifyGates
      expect(pack.guards).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
