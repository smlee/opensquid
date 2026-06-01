/**
 * Behavior test for `pre-research-authoring` (SG.1, 2026-06-01).
 *
 * Loads the REAL builtin `scope-architect` pack through the pack loader (proving
 * the skill.yaml parses + every `if:` compiles) and evaluates each rule's
 * process against a constructed tool_call event in a tmp OPENSQUID_HOME.
 *
 * Why this test exists: the skill previously had only regex-PATTERN tests, never
 * a rule-FIRING test — so its broken `text_field: 'targs.file_path'` (a binding
 * path text_pattern_match can't resolve; it reads ctx.event fields only) made
 * the warn a silent no-op for months. These tests assert the rules actually
 * FIRE through the evaluator, with `args.file_path` / `args.content`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerEventFunctions } from '../functions/event.js';
import { FunctionRegistry } from '../functions/registry.js';
import { SessionToolHistory } from '../functions/session_tool_history.js';
import { TextPatternMatch } from '../functions/text_pattern_match.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import type { ProcessStep, RuleResult } from '../runtime/types.js';

import { loadPack } from './loader.js';

const HERE = fileURLToPath(import.meta.url);
const PACK = resolve(HERE, '../../../packs/builtin/scope-architect');
const SID = 'pra-sess';
const PRE = 'docs/research/T-x-pre-research-2026-06-01.md';

function buildTestRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg); // tool_name, tool_args
  registerVerdictFunctions(reg); // verdict
  reg.register(TextPatternMatch);
  reg.register(SessionToolHistory);
  return reg;
}

function writeEvent(filePath: string, content: string): Event {
  return { kind: 'tool_call', tool: 'Write', args: { file_path: filePath, content }, cwd: '/tmp' };
}
function editEvent(filePath: string): Event {
  return {
    kind: 'tool_call',
    tool: 'Edit',
    args: { file_path: filePath, old_string: 'a', new_string: 'b' },
    cwd: '/tmp',
  };
}

const ALL_3 = [
  '## Alternatives',
  'a',
  '## Failure modes (inversion)',
  'b',
  '## Empirical spikes',
  'c',
].join('\n');
const ONLY_2 = ['## Alternatives', 'a', '## Failure modes', 'b'].join('\n');

let scopeSteps: ProcessStep[]; // warn-scope-incomplete
let activitySteps: ProcessStep[]; // warn-preresearch-write-without-research (the fixed rule)
let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'sg1-pra-'));
  process.env.OPENSQUID_HOME = tempHome;

  const pack = await loadPack(PACK);
  const skill = pack.skills.find((s) => s.name === 'pre-research-authoring');
  const scope = skill?.rules.find((r) => r.id === 'warn-scope-incomplete');
  const activity = skill?.rules.find((r) => r.id === 'warn-preresearch-write-without-research');
  if (scope?.kind !== 'track_check') throw new Error('warn-scope-incomplete not a track_check');
  if (activity?.kind !== 'track_check') throw new Error('warn-preresearch... not a track_check');
  scopeSteps = scope.process;
  activitySteps = activity.process;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

function run(steps: ProcessStep[], event: Event): Promise<RuleResult> {
  return evaluateProcess(
    steps,
    { event, bindings: new Map(), sessionId: SID, packId: 'scope-architect' },
    buildTestRegistry(),
  );
}

describe('pre-research-authoring / warn-scope-incomplete (SG.1)', () => {
  it('WARNS when a pre-research Write is missing a hole-finding section (2 of 3)', async () => {
    const r = await run(scopeSteps, writeEvent(PRE, ONLY_2));
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('warn');
  });

  it('is SILENT when all three sections are present', async () => {
    expect((await run(scopeSteps, writeEvent(PRE, ALL_3))).kind).toBe('no_verdict');
  });

  it('is SILENT on a non-pre-research path (path guard)', async () => {
    expect((await run(scopeSteps, writeEvent('src/foo.ts', ONLY_2))).kind).toBe('no_verdict');
  });

  it('is SILENT on Edit (Write-only by design — Edit content is partial)', async () => {
    expect((await run(scopeSteps, editEvent(PRE))).kind).toBe('no_verdict');
  });
});

describe('pre-research-authoring / warn-preresearch-write-without-research (the SG.1 path fix)', () => {
  it('FIRES now that text_field is args.file_path (was a silent no-op with targs.file_path)', async () => {
    // isolated home → empty tool ledger → research.count 0 < 3 → warn fires,
    // PROVING the path guard now matches (pre-fix it never did).
    const r = await run(activitySteps, writeEvent(PRE, 'anything'));
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('warn');
  });

  it('is SILENT on a non-pre-research path', async () => {
    expect((await run(activitySteps, writeEvent('src/foo.ts', 'x'))).kind).toBe('no_verdict');
  });
});
