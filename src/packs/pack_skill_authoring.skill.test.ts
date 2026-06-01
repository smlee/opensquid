/**
 * Behavior (firing) test for `pack-skill-authoring` (SG.2, 2026-06-01).
 *
 * The skill had only pattern-tests, never a firing test — so its broken
 * `text_field: 'targs.file_path'` (a binding path text_pattern_match can't
 * resolve) made the warn a silent no-op. This asserts it now FIRES via
 * `args.file_path`.
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
const SID = 'psa-sess';

function buildTestRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg);
  registerVerdictFunctions(reg);
  reg.register(TextPatternMatch);
  reg.register(SessionToolHistory);
  return reg;
}
const writeEvent = (filePath: string): Event => ({
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: filePath, content: 'x' },
  cwd: '/tmp',
});

let steps: ProcessStep[];
let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'sg2-psa-'));
  process.env.OPENSQUID_HOME = tempHome;
  const pack = await loadPack(PACK);
  const rule = pack.skills
    .find((s) => s.name === 'pack-skill-authoring')
    ?.rules.find((r) => r.id === 'warn-pack-skill-write-without-research');
  if (rule?.kind !== 'track_check') throw new Error('rule not a track_check');
  steps = rule.process;
});
afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

function run(event: Event): Promise<RuleResult> {
  return evaluateProcess(
    steps,
    { event, bindings: new Map(), sessionId: SID, packId: 'scope-architect' },
    buildTestRegistry(),
  );
}

describe('pack-skill-authoring (SG.2 firing test)', () => {
  it('WARNS on a user-pack skill.yaml write with no research (was a silent no-op)', async () => {
    // isolated home → empty tool ledger → research.count 0 → warn fires.
    const r = await run(writeEvent('/home/u/.opensquid/packs/foo/skill.yaml'));
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('warn');
  });

  it('is SILENT off-path', async () => {
    expect((await run(writeEvent('src/foo.ts'))).kind).toBe('no_verdict');
  });
});
