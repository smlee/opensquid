/**
 * Behavior (firing) tests for the pack-architect walkthrough skills (SG.2).
 *
 * Both were DOUBLE-broken: `text_field: tool_args.file_path` (binding path) AND
 * `is_*.matched == true` (matched is a string[], so == true never held). Either
 * bug alone made them silent no-ops. These assert they now FIRE (surface) via
 * `args.file_path` + `len(...) > 0`.
 */

import { describe, expect, it } from 'vitest';

import { registerEventFunctions } from '../functions/event.js';
import { FunctionRegistry } from '../functions/registry.js';
import { TextPatternMatch } from '../functions/text_pattern_match.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { ProcessStep, RuleResult } from '../runtime/types.js';

import { loadPack } from './loader.js';

const HERE = fileURLToPath(import.meta.url);
const PACK = resolve(HERE, '../../../packs/builtin/pack-architect');

function buildTestRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg);
  registerVerdictFunctions(reg);
  reg.register(TextPatternMatch);
  return reg;
}
const writeEvent = (filePath: string): Event => ({
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: filePath, content: 'x' },
  cwd: '/tmp',
});

async function steps(skillName: string, ruleId: string): Promise<ProcessStep[]> {
  const pack = await loadPack(PACK);
  const rule = pack.skills.find((s) => s.name === skillName)?.rules.find((r) => r.id === ruleId);
  if (rule?.kind !== 'track_check') throw new Error(`${ruleId} not a track_check`);
  return rule.process;
}
function run(s: ProcessStep[], event: Event): Promise<RuleResult> {
  return evaluateProcess(
    s,
    { event, bindings: new Map(), sessionId: 'paw-sess', packId: 'pack-architect' },
    buildTestRegistry(),
  );
}

describe('manifest-author-walkthrough (SG.2 firing test)', () => {
  it('SURFACES on a manifest.yaml write (was double-broken: field path + matched==true)', async () => {
    const s = await steps('manifest-author-walkthrough', 'surface-manifest-authoring-checklist');
    const r = await run(s, writeEvent('packs/foo/manifest.yaml'));
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('surface');
  });
  it('is SILENT off-path', async () => {
    const s = await steps('manifest-author-walkthrough', 'surface-manifest-authoring-checklist');
    expect((await run(s, writeEvent('src/foo.ts'))).kind).toBe('no_verdict');
  });
});

describe('skill-yaml-author-walkthrough (SG.2 firing test)', () => {
  it('SURFACES on a skill.yaml write', async () => {
    const s = await steps(
      'skill-yaml-author-walkthrough',
      'surface-skill-yaml-authoring-checklist',
    );
    const r = await run(s, writeEvent('packs/foo/skills/bar/skill.yaml'));
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('surface');
  });
  it('is SILENT off-path', async () => {
    const s = await steps(
      'skill-yaml-author-walkthrough',
      'surface-skill-yaml-authoring-checklist',
    );
    expect((await run(s, writeEvent('README.md'))).kind).toBe('no_verdict');
  });
});

describe('fsm-author-walkthrough (FSM authoring)', () => {
  it('SURFACES on an fsm.yaml write, citing the FSM doc + transitions', async () => {
    const s = await steps('fsm-author-walkthrough', 'surface-fsm-authoring-checklist');
    const r = await run(s, writeEvent('packs/foo/fsm.yaml'));
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') {
      expect(r.verdict.level).toBe('surface');
      expect(r.verdict.message).toContain('pack-fsm-architecture.md');
      expect(r.verdict.message).toContain('transitions');
    }
  });
  it('is SILENT off-path', async () => {
    const s = await steps('fsm-author-walkthrough', 'surface-fsm-authoring-checklist');
    expect((await run(s, writeEvent('packs/foo/manifest.yaml'))).kind).toBe('no_verdict');
  });
});

describe('pack-architect teaches the FSM surface (content drift-guard)', () => {
  it('the manifest checklist covers guards + the fsm.yaml side-file', async () => {
    const s = await steps('manifest-author-walkthrough', 'surface-manifest-authoring-checklist');
    const r = await run(s, writeEvent('packs/foo/manifest.yaml'));
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') {
      expect(r.verdict.message).toContain('guards');
      expect(r.verdict.message).toContain('fsm.yaml');
    }
  });
});
