/**
 * Tests for the destination-check scheduler.
 *
 * Strategy: per-test temp `OPENSQUID_HOME` via `mkdtemp` so the counter
 * file lives in an isolated dir and never leaks between cases. Scheduler
 * receives a hand-built `Pack[]` (no YAML, no loader) so each case
 * declares exactly the rules it cares about.
 *
 * Coverage (≥ 4 per acceptance criteria, plus a few edges):
 *   1. interval=5, 5 calls → fires exactly once on the 5th, returns the key.
 *   2. Counter persists across calls — verify the JSON file content
 *      reflects increments between invocations.
 *   3. Counter resets to 0 on fire so the next 5 calls fire again.
 *   4. No destination_check rules → empty dueRules, no crash.
 *   5. Multiple rules with different intervals fire independently.
 *   6. Track_check rules are ignored (don't tick the counter or fire).
 *   7. Composite key format `pack::skill::rule`.
 *   8. Missing state file (first call) — initial counters start at 0.
 *   9. Corrupted state file — reads as empty, doesn't crash.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionStateFile } from './paths.js';
import { destinationRuleKey, maybeRunDestinationChecks } from './destination_scheduler.js';
import type { Pack } from './types.js';

// ---------------------------------------------------------------------------
// Per-test sandbox: a fresh OPENSQUID_HOME under tmpdir so every test reads
// + writes its own counter file. afterEach restores the prior env and
// rm -rf's the dir.
// ---------------------------------------------------------------------------

let tmpRoot: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tmpRoot = await mkdtemp(join(tmpdir(), 'opensquid-destsched-test-'));
  process.env.OPENSQUID_HOME = tmpRoot;
});

afterEach(async () => {
  if (priorHome === undefined) {
    delete process.env.OPENSQUID_HOME;
  } else {
    process.env.OPENSQUID_HOME = priorHome;
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pack factory — builds a minimal Pack with one destination_check rule.
// Cast-free; produces a valid runtime Pack shape (no preprocessing needed).
// ---------------------------------------------------------------------------

function makeDestinationPack(opts: {
  packName?: string;
  skillName?: string;
  ruleId?: string;
  every: number;
}): Pack {
  return {
    name: opts.packName ?? 'p1',
    version: '0.0.1',
    scope: 'project',
    goal: 'Ship the form',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills: [
      {
        name: opts.skillName ?? 's1',
        load: 'lazy',
        when_to_load: [],
        unloads_when: [],
        triggers: [{ kind: 'tool_call' }],
        rules: [
          {
            id: opts.ruleId ?? 'g1',
            kind: 'destination_check',
            interval: { every_n_tool_calls: opts.every },
            model_alias: 'reasoning',
            prompt_template: 'On goal?',
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

describe('maybeRunDestinationChecks', () => {
  it('fires exactly once on the Nth call when interval = N', async () => {
    const sessionId = 'sess-fire-once';
    const packs = [makeDestinationPack({ every: 5 })];

    const r1 = await maybeRunDestinationChecks(sessionId, packs);
    const r2 = await maybeRunDestinationChecks(sessionId, packs);
    const r3 = await maybeRunDestinationChecks(sessionId, packs);
    const r4 = await maybeRunDestinationChecks(sessionId, packs);
    const r5 = await maybeRunDestinationChecks(sessionId, packs);

    expect(r1).toEqual([]);
    expect(r2).toEqual([]);
    expect(r3).toEqual([]);
    expect(r4).toEqual([]);
    expect(r5).toEqual(['p1::s1::g1']);
  });

  it('persists the counter to disk between calls', async () => {
    const sessionId = 'sess-persist';
    const packs = [makeDestinationPack({ every: 5 })];

    await maybeRunDestinationChecks(sessionId, packs);
    await maybeRunDestinationChecks(sessionId, packs);

    const path = sessionStateFile(sessionId, 'destination-counters');
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { byRule: Record<string, number> };
    expect(parsed.byRule['p1::s1::g1']).toBe(2);
  });

  it('resets the counter to 0 on fire so the rule fires again every N calls', async () => {
    const sessionId = 'sess-reset';
    const packs = [makeDestinationPack({ every: 3 })];

    const r1 = await maybeRunDestinationChecks(sessionId, packs);
    const r2 = await maybeRunDestinationChecks(sessionId, packs);
    const r3 = await maybeRunDestinationChecks(sessionId, packs);
    const r4 = await maybeRunDestinationChecks(sessionId, packs);
    const r5 = await maybeRunDestinationChecks(sessionId, packs);
    const r6 = await maybeRunDestinationChecks(sessionId, packs);

    expect(r1).toEqual([]);
    expect(r2).toEqual([]);
    expect(r3).toEqual(['p1::s1::g1']);
    expect(r4).toEqual([]);
    expect(r5).toEqual([]);
    expect(r6).toEqual(['p1::s1::g1']);

    // After the second fire, the counter resets to 0 again.
    const path = sessionStateFile(sessionId, 'destination-counters');
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { byRule: Record<string, number> };
    expect(parsed.byRule['p1::s1::g1']).toBe(0);
  });

  it('returns an empty list when no packs declare destination_check rules', async () => {
    const sessionId = 'sess-no-dest';
    const packs: Pack[] = [
      {
        name: 'track-only',
        version: '0.0.1',
        scope: 'project',
        goal: 'Track only',
        description: '',
        requires: [],
        conflicts: [],
        evolves: true,
        skills: [
          {
            name: 's',
            load: 'lazy',
            when_to_load: [],
            unloads_when: [],
            triggers: [{ kind: 'tool_call' }],
            rules: [
              {
                id: 't',
                kind: 'track_check',
                process: [{ call: 'verdict', args: { level: 'pass', message: '' } }],
              },
            ],
          },
        ],
      },
    ];

    const due = await maybeRunDestinationChecks(sessionId, packs);
    expect(due).toEqual([]);
  });

  it('fires independent counters for rules with different intervals', async () => {
    const sessionId = 'sess-multi';
    const packs: Pack[] = [
      makeDestinationPack({ packName: 'p1', ruleId: 'r-fast', every: 2 }),
      makeDestinationPack({ packName: 'p2', ruleId: 'r-slow', every: 3 }),
    ];

    const r1 = await maybeRunDestinationChecks(sessionId, packs);
    const r2 = await maybeRunDestinationChecks(sessionId, packs);
    const r3 = await maybeRunDestinationChecks(sessionId, packs);

    expect(r1).toEqual([]);
    expect(r2).toEqual(['p1::s1::r-fast']);
    expect(r3).toEqual(['p2::s1::r-slow']);
  });

  it('ignores track_check rules when ticking the counter', async () => {
    const sessionId = 'sess-mixed';
    const packs: Pack[] = [
      {
        name: 'mixed',
        version: '0.0.1',
        scope: 'project',
        goal: 'g',
        description: '',
        requires: [],
        conflicts: [],
        evolves: true,
        skills: [
          {
            name: 's',
            load: 'lazy',
            when_to_load: [],
            unloads_when: [],
            triggers: [{ kind: 'tool_call' }],
            rules: [
              {
                id: 'track-rule',
                kind: 'track_check',
                process: [{ call: 'verdict', args: { level: 'pass', message: '' } }],
              },
              {
                id: 'dest-rule',
                kind: 'destination_check',
                interval: { every_n_tool_calls: 2 },
                model_alias: 'reasoning',
                prompt_template: 'On goal?',
              },
            ],
          },
        ],
      },
    ];

    const r1 = await maybeRunDestinationChecks(sessionId, packs);
    const r2 = await maybeRunDestinationChecks(sessionId, packs);
    expect(r1).toEqual([]);
    expect(r2).toEqual(['mixed::s::dest-rule']);

    // Counter file only has the dest-rule key, not the track-rule key.
    const path = sessionStateFile(sessionId, 'destination-counters');
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { byRule: Record<string, number> };
    expect(Object.keys(parsed.byRule)).toEqual(['mixed::s::dest-rule']);
  });

  it('builds the composite key as pack::skill::rule', () => {
    expect(destinationRuleKey('alpha', 'beta', 'gamma')).toBe('alpha::beta::gamma');
  });

  it('starts the counter at 0 when the state file does not exist', async () => {
    const sessionId = 'sess-fresh';
    const packs = [makeDestinationPack({ every: 1 })];

    // interval=1 → must fire on the very first call.
    const due = await maybeRunDestinationChecks(sessionId, packs);
    expect(due).toEqual(['p1::s1::g1']);
  });

  it('treats a corrupted state file as empty and does not crash', async () => {
    const sessionId = 'sess-corrupt';
    const path = sessionStateFile(sessionId, 'destination-counters');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{this is not valid json', 'utf8');

    const packs = [makeDestinationPack({ every: 2 })];

    const r1 = await maybeRunDestinationChecks(sessionId, packs);
    const r2 = await maybeRunDestinationChecks(sessionId, packs);

    expect(r1).toEqual([]);
    expect(r2).toEqual(['p1::s1::g1']);

    // The corrupted file has been overwritten with valid JSON.
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { byRule: Record<string, number> };
    expect(parsed.byRule['p1::s1::g1']).toBe(0);
  });
});
