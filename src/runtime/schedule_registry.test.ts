/**
 * Tests for `buildScheduleRegistry` — load-time cron validation.
 *
 * Coverage:
 *   1. Single schedule trigger with valid 5-field cron → one entry, correct id.
 *   2. Multiple packs × skills × triggers → flat entry list, all IDs unique.
 *   3. Non-schedule triggers (tool_call, webhook) → skipped silently.
 *   4. Missing `cron:` field on a schedule trigger → ScheduleRegistryError.
 *   5. 6-field (seconds-first) cron → ScheduleRegistryError with specific
 *      message naming "6-field" so the operator knows what to fix.
 *   6. Malformed cron → ScheduleRegistryError surfaces pack + skill + index.
 *   7. Wrong field count (3 / 7) → rejected.
 *   8. Empty pack list → empty entries, no error.
 */

import { describe, expect, it } from 'vitest';

import { buildScheduleRegistry, ScheduleRegistryError } from './schedule_registry.js';
import type { Pack } from './types.js';

function pack(name: string, skills: Pack['skills']): Pack {
  return {
    name,
    version: '0.0.1',
    scope: 'project',
    goal: 'test',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills,
  };
}

function scheduleSkill(name: string, cronExpr: string): Pack['skills'][number] {
  return {
    name,
    load: 'lazy',
    when_to_load: [],
    requires: [],
    unloads_when: [],
    triggers: [{ kind: 'schedule', cron: cronExpr }],
    rules: [],
  };
}

describe('buildScheduleRegistry', () => {
  it('emits one entry per valid schedule trigger', () => {
    const p = pack('billing', [scheduleSkill('digest', '0 9 * * 1')]);
    const entries = buildScheduleRegistry([p]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      pack: 'billing',
      skill: 'digest',
      cron: '0 9 * * 1',
      timezone: 'UTC',
    });
    expect(entries[0]?.id).toMatch(/^billing::digest::\d+$/);
  });

  it('flattens multiple packs and skills', () => {
    const packs = [
      pack('a', [scheduleSkill('s1', '*/5 * * * *'), scheduleSkill('s2', '0 12 * * *')]),
      pack('b', [scheduleSkill('s3', '0 0 * * 0')]),
    ];
    const entries = buildScheduleRegistry(packs);
    expect(entries).toHaveLength(3);
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('ignores non-schedule triggers', () => {
    const p = pack('mixed', [
      {
        name: 'multi',
        load: 'lazy',
        when_to_load: [],
        requires: [],
        unloads_when: [],
        triggers: [
          { kind: 'tool_call' },
          { kind: 'webhook', path: '/x' },
          { kind: 'schedule', cron: '0 9 * * *' },
        ],
        rules: [],
      },
    ]);
    const entries = buildScheduleRegistry([p]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.cron).toBe('0 9 * * *');
  });

  it('throws on missing cron field', () => {
    const p = pack('bad', [
      {
        name: 's',
        load: 'lazy',
        when_to_load: [],
        requires: [],
        unloads_when: [],
        triggers: [{ kind: 'schedule' }],
        rules: [],
      },
    ]);
    expect(() => buildScheduleRegistry([p])).toThrow(ScheduleRegistryError);
    try {
      buildScheduleRegistry([p]);
    } catch (err) {
      expect((err as ScheduleRegistryError).pack).toBe('bad');
      expect((err as ScheduleRegistryError).skill).toBe('s');
      expect((err as Error).message).toMatch(/missing required `cron:`/);
    }
  });

  it('rejects 6-field (seconds-first) cron with a specific error', () => {
    const p = pack('quartz', [scheduleSkill('every5s', '*/5 * * * * *')]);
    expect(() => buildScheduleRegistry([p])).toThrow(/6-field/);
  });

  it('rejects malformed cron with provenance', () => {
    const p = pack('typo', [scheduleSkill('bad', 'not even close')]);
    try {
      buildScheduleRegistry([p]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ScheduleRegistryError);
      expect((err as ScheduleRegistryError).pack).toBe('typo');
      expect((err as Error).message).toMatch(/typo/);
      expect((err as Error).message).toMatch(/bad/);
    }
  });

  it('rejects 3-field and 7-field cron with helpful error', () => {
    expect(() => buildScheduleRegistry([pack('p', [scheduleSkill('s', '0 9 *')])])).toThrow(
      /3 fields/,
    );
    expect(() => buildScheduleRegistry([pack('p', [scheduleSkill('s', '0 9 * * * * *')])])).toThrow(
      /7 fields/,
    );
  });

  it('returns an empty list for zero packs', () => {
    expect(buildScheduleRegistry([])).toEqual([]);
  });
});
