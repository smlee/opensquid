/**
 * Unit tests for the Skill.requires AND-precondition evaluator (T-ASC, ASC.2).
 *
 * Coverage:
 *   - empty preconds → trivially holds (back-compat)
 *   - each kind in isolation: automation_mode_on / active_task_present / chain_stage
 *   - AND-semantics: 2-precond skill fails when EITHER fails
 *   - chain_stage: matches when stage equals; doesn't match otherwise
 *   - RequiresCache: shares results across calls within one cache instance
 *   - fail-open: a stat error other than ENOENT → true (engaged direction)
 *   - schema validation: SkillRequires Zod rejects unknown discriminator
 *
 * Every test isolates OPENSQUID_HOME via mkdtemp per L11.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { automationFlagPath, setAutomationFlag } from './automation_state.js';
import { transitionChainStage } from './chain_state.js';
import { activeTaskFile } from './paths.js';
import { writeActiveTask } from './session_state.js';
import { RequiresCache, SkillRequires, skillRequiresHold } from './skill_requires.js';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-skill-requires-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('SkillRequires — schema validation', () => {
  it('accepts each kind variant', () => {
    expect(SkillRequires.parse({ kind: 'automation_mode_on' })).toEqual({
      kind: 'automation_mode_on',
    });
    expect(SkillRequires.parse({ kind: 'active_task_present' })).toEqual({
      kind: 'active_task_present',
    });
    expect(SkillRequires.parse({ kind: 'chain_stage', stage: 'researched' })).toEqual({
      kind: 'chain_stage',
      stage: 'researched',
    });
  });

  it('rejects an unknown kind (no silent fall-through)', () => {
    expect(() => SkillRequires.parse({ kind: 'unknown_kind' })).toThrow();
  });

  it('rejects chain_stage with an unknown stage', () => {
    expect(() => SkillRequires.parse({ kind: 'chain_stage', stage: 'unmapped' })).toThrow();
  });

  it('rejects unknown fields on variants (.strict)', () => {
    expect(() => SkillRequires.parse({ kind: 'automation_mode_on', extra: 'oops' })).toThrow();
  });
});

describe('skillRequiresHold — empty + trivially-holds', () => {
  it('empty preconds → true (back-compat)', async () => {
    expect(await skillRequiresHold([], 's', new RequiresCache())).toBe(true);
  });
});

describe('skillRequiresHold — automation_mode_on', () => {
  it('false when flag is absent', async () => {
    const preconds = SkillRequires.array().parse([{ kind: 'automation_mode_on' }]);
    expect(await skillRequiresHold(preconds, 's', new RequiresCache())).toBe(false);
  });

  it('true when flag is present', async () => {
    await setAutomationFlag('s');
    const preconds = SkillRequires.array().parse([{ kind: 'automation_mode_on' }]);
    expect(await skillRequiresHold(preconds, 's', new RequiresCache())).toBe(true);
  });
});

describe('skillRequiresHold — active_task_present', () => {
  it('false when active-task.json is absent', async () => {
    const preconds = SkillRequires.array().parse([{ kind: 'active_task_present' }]);
    expect(await skillRequiresHold(preconds, 's', new RequiresCache())).toBe(false);
  });

  it('true when active-task.json is present', async () => {
    await writeActiveTask('s', {
      id: 't1',
      subject: 'x',
      started_at: new Date().toISOString(),
    });
    const preconds = SkillRequires.array().parse([{ kind: 'active_task_present' }]);
    expect(await skillRequiresHold(preconds, 's', new RequiresCache())).toBe(true);
  });
});

describe('skillRequiresHold — chain_stage', () => {
  it('false when chain is idle but precondition expects researched', async () => {
    const preconds = SkillRequires.array().parse([{ kind: 'chain_stage', stage: 'researched' }]);
    expect(await skillRequiresHold(preconds, 's', new RequiresCache())).toBe(false);
  });

  it('true when chain stage equals the precondition stage', async () => {
    await transitionChainStage('s', 'researched');
    const preconds = SkillRequires.array().parse([{ kind: 'chain_stage', stage: 'researched' }]);
    expect(await skillRequiresHold(preconds, 's', new RequiresCache())).toBe(true);
  });

  it('false when chain stage is past the precondition stage', async () => {
    await transitionChainStage('s', 'researched');
    await transitionChainStage('s', 'spec_authored');
    const preconds = SkillRequires.array().parse([{ kind: 'chain_stage', stage: 'researched' }]);
    expect(await skillRequiresHold(preconds, 's', new RequiresCache())).toBe(false);
  });
});

describe('skillRequiresHold — AND-semantics', () => {
  it('returns false when ANY precondition fails (short-circuit)', async () => {
    await setAutomationFlag('s');
    // automation_mode_on holds; active_task_present does NOT
    const preconds = SkillRequires.array().parse([
      { kind: 'automation_mode_on' },
      { kind: 'active_task_present' },
    ]);
    expect(await skillRequiresHold(preconds, 's', new RequiresCache())).toBe(false);
  });

  it('returns true when all preconditions hold', async () => {
    await setAutomationFlag('s');
    await writeActiveTask('s', {
      id: 't1',
      subject: 'x',
      started_at: new Date().toISOString(),
    });
    await transitionChainStage('s', 'researched');
    const preconds = SkillRequires.array().parse([
      { kind: 'automation_mode_on' },
      { kind: 'active_task_present' },
      { kind: 'chain_stage', stage: 'researched' },
    ]);
    expect(await skillRequiresHold(preconds, 's', new RequiresCache())).toBe(true);
  });
});

describe('RequiresCache — within-call reuse', () => {
  it('a second call for the same kind reads from cache (not disk)', async () => {
    await setAutomationFlag('s');
    const cache = new RequiresCache();
    // Seed the cache with one call.
    expect(await cache.automationModeOn('s')).toBe(true);
    // Mutate disk underneath the cache (clear the flag) — the cached value
    // should NOT reflect the on-disk change.
    const { unlink } = await import('node:fs/promises');
    await unlink(automationFlagPath('s'));
    // Second call inside the same cache: cached `true` wins.
    expect(await cache.automationModeOn('s')).toBe(true);
    // A fresh cache reads disk again → now false.
    expect(await new RequiresCache().automationModeOn('s')).toBe(false);
  });

  it('chain_stage cached value used for subsequent comparisons against any stage', async () => {
    await transitionChainStage('s', 'researched');
    const cache = new RequiresCache();
    // First hold call resolves the cache.
    expect(
      await skillRequiresHold(
        SkillRequires.array().parse([{ kind: 'chain_stage', stage: 'researched' }]),
        's',
        cache,
      ),
    ).toBe(true);
    // Mutate disk underneath — should NOT change the cached stage.
    await transitionChainStage('s', 'spec_authored');
    // Second hold against same cache still sees 'researched'.
    expect(
      await skillRequiresHold(
        SkillRequires.array().parse([{ kind: 'chain_stage', stage: 'researched' }]),
        's',
        cache,
      ),
    ).toBe(true);
    expect(
      await skillRequiresHold(
        SkillRequires.array().parse([{ kind: 'chain_stage', stage: 'spec_authored' }]),
        's',
        cache,
      ),
    ).toBe(false);
  });
});

describe('skillRequiresHold — fail-open on non-ENOENT stat error', () => {
  it('returns true (engaged) when stat throws EACCES on the flag path', async () => {
    // Seed automation flag, then chmod 000 the directory so the stat probe
    // gets EACCES from inside. macOS' fs honors POSIX perms — the stat call
    // on a child of a 000 dir raises EACCES.
    const sessionId = 'sfailopen';
    await setAutomationFlag(sessionId);
    const flagDir = dirname(automationFlagPath(sessionId));
    const { chmod } = await import('node:fs/promises');
    await chmod(flagDir, 0o000);
    try {
      const preconds = SkillRequires.array().parse([{ kind: 'automation_mode_on' }]);
      // Fail-open posture: an EACCES error inside the probe ⇒ true (engaged),
      // never silently disabled.
      expect(await skillRequiresHold(preconds, sessionId, new RequiresCache())).toBe(true);
    } finally {
      // Restore permissions so afterEach's rm can clean up.
      await chmod(flagDir, 0o755);
    }
  });
});

describe('active_task_present probe path', () => {
  it('uses activeTaskFile (active-task.json), not active-task.jsonl', async () => {
    // Confirms the probe targets the right path — the AP.1 mirror writes
    // active-task.json; a probe targeting .jsonl would be silent.
    await writeFile(activeTaskFile('s'), '{}', 'utf8').catch(async () => {
      // mkdir -p if the parent dir doesn't exist yet (matches the mirror's pattern)
      await mkdir(dirname(activeTaskFile('s')), { recursive: true });
      await writeFile(activeTaskFile('s'), '{}', 'utf8');
    });
    const preconds = SkillRequires.array().parse([{ kind: 'active_task_present' }]);
    expect(await skillRequiresHold(preconds, 's', new RequiresCache())).toBe(true);
  });
});
