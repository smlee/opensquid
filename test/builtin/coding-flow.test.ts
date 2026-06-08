/**
 * Built-in `coding-flow` pack (T-FSM-UNIFY) — the unified, FSM-driven
 * problem-solving discipline that supersedes scope-fsm + workflow-fsm. FU.1
 * covers the FSM backbone only (manifest + fsm.yaml); the guards land in FU.2.
 * This proves the on-disk union machine loads + is total, with the three
 * region-defining edges intact (guess-audit loop-back, spec-audit advance).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registerEventFunctions } from '../../src/functions/event.js';
import { registerFsmFunctions } from '../../src/functions/fsm.js';
import { FunctionRegistry } from '../../src/functions/registry.js';
import { registerStateFunctions } from '../../src/functions/state.js';
import { registerVerdictFunctions } from '../../src/functions/verdict.js';
import { loadPack } from '../../src/packs/loader.js';
import { step, validateFsm } from '../../src/runtime/fsm.js';
import { advanceFsmState, readFsmState } from '../../src/runtime/fsm_state.js';
import { dispatchEvent } from '../../src/runtime/hooks/dispatch.js';
import { err, ok } from '../../src/runtime/result.js';
import {
  HasActiveTask,
  HasGeneratedSpec,
  OpenTaskCount,
  WorkflowPhasesComplete,
} from '../../src/functions/active_task.js';
import { appendTool, writeActiveTask } from '../../src/runtime/session_state.js';
import { EffectiveContent } from '../../src/functions/effective_content.js';
import { SessionToolHistory } from '../../src/functions/session_tool_history.js';
import { TextPatternMatch } from '../../src/functions/text_pattern_match.js';
import { appendPhase, REQUIRED_PHASES } from '../../src/runtime/workflow_phases.js';
import type { ToolCallEvent } from '../../src/runtime/types.js';
import type { PromptSubmitEvent } from '../../src/runtime/event.js';

function registry(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerFsmFunctions(r);
  registerStateFunctions(r);
  registerVerdictFunctions(r);
  r.register(HasGeneratedSpec); // FU.12: scope-before-code now consults the active task's spec
  r.register(TextPatternMatch); // FU.3: enter-scoping classifies the track via text_pattern_match
  r.register(SessionToolHistory); // AF.1: scope-advance consults research depth
  r.register(EffectiveContent); // AF.1/FU.4: scope-advance + spec-audit read the post-write artifact
  r.register(OpenTaskCount); // AF.6: pause-prevention derives run-active
  return r;
}

describe('scope-audit ↔ lexicon consistency (Full-fix-over-patch drift guard)', () => {
  it('the audit prompt enforces every lexicon design principle it claims, and the lexicon defines them', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const skill = pack.skills.find((s) => s.name === 'scope-lifecycle');
    expect(skill).toBeDefined();
    const auditPrompt = skill!.rules
      .flatMap((r) => (r.kind === 'track_check' ? r.process : []))
      .filter((p) => p.call === 'subagent_call')
      .map((p) => (p.args as { prompt?: string }).prompt ?? '')
      .find((p) => p.includes('adversarial reviewer'));
    expect(auditPrompt).toBeDefined();
    // Each lexicon-enforced principle must have a clause in the self-contained prompt.
    expect(auditPrompt).toMatch(/NEVER-GUESS/);
    expect(auditPrompt).toMatch(/BEST-SOLUTION/);
    expect(auditPrompt).toMatch(/FULL-FIX/);
    // …and the lexicon must define the guideline the prompt enforces (no lexicon↔prompt drift).
    const lexicon = await readFile(resolve('docs/lexicon.md'), 'utf8');
    expect(lexicon).toMatch(/\*\*Full-fix over patch\*\*/);
  });
});

const writeCode: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'src/feature.ts' },
};
const writeResearch: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'docs/research/x-pre-research-2026-06-03.md' },
};
const writeSpec: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'docs/tasks/T-x.md' },
};
const taskCreate: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'TaskCreate',
  args: { metadata: { taskId: 'X.1', spec: '/abs/spec.md' } },
};

describe('builtin coding-flow pack — FSM backbone (FU.1)', () => {
  it('loads with the union FSM and is total (validateFsm clean)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(pack.name).toBe('coding-flow');
    expect(pack.fsm?.initial).toBe('idle');
    expect(pack.fsm?.states).toEqual([
      'idle',
      'scoping',
      'researching',
      'researched',
      'spec_authored',
      'spec_complete',
      'tasks_loaded',
      'phases_in_flight',
      'phases_complete',
    ]);
    expect(validateFsm(pack.fsm!)).toEqual([]);
  });

  it('SCOPE: guess-audit loops researched back to researching (D3)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'researched', 'guess_found')).toMatchObject({
      next: 'researching',
      transitioned: true,
    });
    expect(step(pack.fsm!, 'researching', 'research_done')).toMatchObject({
      next: 'researched',
      transitioned: true,
    });
  });

  it('AUTHOR: spec-audit advances spec_authored → spec_complete, then tasks_loaded (D7)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'researched', 'spec_drafted')).toMatchObject({ next: 'spec_authored' });
    expect(step(pack.fsm!, 'spec_authored', 'spec_verified')).toMatchObject({
      next: 'spec_complete',
    });
    expect(step(pack.fsm!, 'spec_complete', 'tasks_loaded')).toMatchObject({
      next: 'tasks_loaded',
    });
  });

  it('is total: an unmatched event is an explicit stay, never a crash', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'researched', 'no_such_event')).toMatchObject({
      next: 'researched',
      transitioned: false,
    });
    // spec_complete cannot be skipped: a stray research_done at spec_authored stays put
    expect(step(pack.fsm!, 'spec_authored', 'research_done')).toMatchObject({
      next: 'spec_authored',
      transitioned: false,
    });
  });
});

describe('builtin coding-flow pack — gates fire through the dispatcher (FU.2)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('GF.3: scope-before-code is a NUDGE (warn) — fires pre-scope/pre-audit, silent at spec_complete', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE'); // AF.1: research advance now needs a GUESS_FREE audit
    const sid = 'cf-scope';
    // idle + no task → nudge (warn, exit 0 — GF.3 demoted the block; the git gate is the guarantee).
    let r = await dispatchEvent(writeCode, [pack], reg, sid);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/scope before code/i);
    // AF.1: the research advance is gated on depth (recall+Read+Grep >= 3 this turn).
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    expect((await dispatchEvent(writeResearch, [pack], reg, sid)).exitCode).toBe(0); // → researched
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-03T00:00:00.000Z',
      spec: resolve('package.json'),
    });
    // GF.4 (F7) condition still holds: a stub spec at `researched` is not spec_complete → still nudged.
    r = await dispatchEvent(writeCode, [pack], reg, sid);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/scope before code/i);
    // Drive AUTHOR to spec_complete → the nudge goes silent.
    await dispatchEvent(specWithContent, [pack], reg, sid); // → spec_authored → spec_verified → spec_complete
    r = await dispatchEvent(writeCode, [pack], reg, sid);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/scope before code/i);
  });

  it('GF.3: a --no-verify commit is BLOCKED (the one sound matcher)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-noverify';
    const noVerify: ToolCallEvent = {
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git commit -m wip --no-verify' },
    };
    expect((await dispatchEvent(noVerify, [pack], reg, sid)).exitCode).toBe(2);
    // a plain commit is NOT matched by this rule (GF.2's git hook governs it).
    const plain: ToolCallEvent = {
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git commit -m wip' },
    };
    const r = await dispatchEvent(plain, [pack], reg, sid);
    expect(r.stderr).not.toMatch(/--no-verify bypasses/);
  });

  it('AUTHOR gate: TaskCreate is blocked until the spec passes audit (stays at spec_authored)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-author';
    await dispatchEvent(writeResearch, [pack], reg, sid); // → researched
    await dispatchEvent(writeSpec, [pack], reg, sid); // → spec_authored (no audit stub → never spec_verified)
    // The AUTHOR content gate: no tasks until spec_complete.
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(2);
  });
});

describe('builtin coding-flow pack — track-type region profiles (FU.3)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-fu3-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  // A scope-authoring prompt — `enter-scoping` classifies + records coding-flow-track.
  // The fix/doc/trivial downgrade only fires when the prompt ALSO matches a scope-intent
  // keyword (the classification is gated on scope-entry), so each fixture carries both.
  const prompt = (text: string): PromptSubmitEvent => ({ kind: 'prompt_submit', prompt: text });

  it('feature track → AUTHOR gate FIRES (TaskCreate blocked before spec_complete)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-fu3-feature';
    await dispatchEvent(prompt('add a new task for the feature'), [pack], reg, sid); // track=feature
    await dispatchEvent(writeResearch, [pack], reg, sid); // → researched
    await dispatchEvent(writeSpec, [pack], reg, sid); // → spec_authored
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(2); // feature → AUTHOR fires
  });

  it('fix track → AUTHOR gate SKIPS (TaskCreate allowed at spec_authored)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-fu3-fix';
    await dispatchEvent(prompt('new task to fix the bug'), [pack], reg, sid); // track=fix (no feature intent)
    await dispatchEvent(writeResearch, [pack], reg, sid); // → researched
    await dispatchEvent(writeSpec, [pack], reg, sid); // → spec_authored
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(0); // fix → AUTHOR skipped
  });

  it('stale fix-track RESET to feature on a later feature scope entry (fail-safe strictest)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-fu3-reset';
    await dispatchEvent(prompt('new task to fix the bug'), [pack], reg, sid); // track=fix (no feature intent)
    await dispatchEvent(prompt('new task to design the feature'), [pack], reg, sid); // reset → feature
    await dispatchEvent(writeResearch, [pack], reg, sid); // → researched
    await dispatchEvent(writeSpec, [pack], reg, sid); // → spec_authored
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(2); // reset → AUTHOR fires
  });

  // GF.5 (F5): a MIXED-intent prompt (feature + fix) stays `feature` — one stray fix
  // keyword can no longer disable the AUTHOR gate for the whole session.
  it('GF.5: mixed feature+fix prompt stays feature → AUTHOR gate FIRES', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-gf5-mixed';
    // "plan" = scope intent; "build"/"feature" = feature intent; "fix" = fix keyword.
    await dispatchEvent(
      prompt('plan to build the export feature and fix the header spacing'),
      [pack],
      reg,
      sid,
    );
    await dispatchEvent(writeResearch, [pack], reg, sid); // → researched
    await dispatchEvent(writeSpec, [pack], reg, sid); // → spec_authored
    // feature intent present → NOT downgraded → AUTHOR fires (TaskCreate blocked).
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(2);
  });
});

/** Prompt-aware subagent_call stub: the guess-audit prompt (NEVER-GUESS) always
 *  passes GUESS_FREE so research reaches `researched`; the spec-audit prompt gets
 *  the configurable `specVerdict` — so the AUTHOR gate's determinism is under test. */
function registryWithAudit(specVerdict: string): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerFsmFunctions(r);
  registerStateFunctions(r);
  registerVerdictFunctions(r);
  r.register({
    name: 'subagent_call',
    argSchema: z.object({
      model: z.string(),
      prompt: z.string(),
      timeout_ms: z.number().optional(),
    }),
    durable: false,
    execute: (args: { prompt: string }) =>
      Promise.resolve(
        ok(args.prompt.includes('NEVER-GUESS') ? 'VERDICT: GUESS_FREE' : specVerdict),
      ),
  });
  r.register(SessionToolHistory); // AF.1: scope-advance consults research depth
  r.register(EffectiveContent); // AF.1/FU.4: scope-advance + spec-audit read the post-write artifact
  r.register(HasGeneratedSpec); // scope-before-code consults the active task's spec
  r.register(OpenTaskCount); // AF.6: pause-prevention derives run-active
  r.register(TextPatternMatch); // GF.1: enter-scoping classifies the track / advances scope_start
  return r;
}

const researchWithContent: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: {
    file_path: 'docs/research/x-pre-research-2026-06-03.md',
    content: '# Pre-research\n\nDerived from src/foo.ts:1.',
  },
};
const specWithContent: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'docs/tasks/T-x.md', content: '### Task X.1\n\n(real 11-field spec)' },
};

describe('builtin coding-flow pack — the AUTHOR content gate end-to-end (spec-audit, FU.4)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-audit-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('SPEC_COMPLETE audit → spec_complete → TaskCreate allowed', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE');
    const sid = 'cf-audit-pass';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t); // AF.1 depth
    await dispatchEvent(researchWithContent, [pack], reg, sid); // → researched
    await dispatchEvent(specWithContent, [pack], reg, sid); // → spec_authored → spec_verified → spec_complete
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('spec_complete');
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(0); // AUTHOR complete → allowed
  });

  it('INCOMPLETE audit → stays spec_authored → TaskCreate blocked', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: INCOMPLETE\n- Task X.1 missing Test fixtures');
    const sid = 'cf-audit-fail';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t); // AF.1 depth
    await dispatchEvent(researchWithContent, [pack], reg, sid); // → researched
    await dispatchEvent(specWithContent, [pack], reg, sid); // → spec_authored (audit failed: stays)
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('spec_authored');
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(2); // not spec_complete → blocked
  });

  // AF.4: the Simplicity criterion is fail-closed too — an over-complected design
  // (the 11-field contract + coverage may pass, but the lexicon Simplicity rule fails)
  // keeps the spec at spec_authored, so TaskCreate stays blocked.
  it('AF.4: over-complected design → INCOMPLETE → stays spec_authored → TaskCreate blocked', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit(
      'VERDICT: INCOMPLETE\n- Over-complected: 6 special-cased branches signal a missed decomposition (Simplicity, docs/lexicon.md)',
    );
    const sid = 'cf-audit-simplicity';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t); // AF.1 depth
    await dispatchEvent(researchWithContent, [pack], reg, sid); // → researched
    await dispatchEvent(specWithContent, [pack], reg, sid); // → spec_authored (Simplicity failed: stays)
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('spec_authored');
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(2); // not spec_complete → blocked
  });
});

/** Per-audit outcome stub (F0c). `scopeOut` answers the guess-audit (NEVER-GUESS
 *  prompt), `specOut` the spec-audit; the sentinel 'THROW' makes that audit return
 *  a FunctionError, modelling a subagent that could not spawn. */
function registryWithAuditOutcomes(scopeOut: string, specOut: string): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerFsmFunctions(r);
  registerStateFunctions(r);
  registerVerdictFunctions(r);
  r.register({
    name: 'subagent_call',
    argSchema: z.object({
      model: z.string(),
      prompt: z.string(),
      timeout_ms: z.number().optional(),
    }),
    durable: false,
    execute: (args: { prompt: string }) => {
      const out = args.prompt.includes('NEVER-GUESS') ? scopeOut : specOut;
      return Promise.resolve(
        out === 'THROW' ? err({ kind: 'runtime', message: 'spawn refused' }) : ok(out),
      );
    },
  });
  r.register(SessionToolHistory);
  r.register(EffectiveContent);
  r.register(HasGeneratedSpec);
  r.register(OpenTaskCount);
  r.register(TextPatternMatch);
  return r;
}

describe('builtin coding-flow pack — F0c: audits degrade gracefully on subagent-spawn failure', () => {
  let tempHome: string;
  let priorHome: string | undefined;
  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-f0c-'));
    process.env.OPENSQUID_HOME = tempHome;
  });
  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('SCOPE audit spawn-failure → actionable BLOCK (exit 2), FSM does NOT advance to researched', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAuditOutcomes('THROW', 'VERDICT: SPEC_COMPLETE');
    const sid = 'cf-f0c-scope-unavailable';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t); // depth >= 3
    const res = await dispatchEvent(researchWithContent, [pack], reg, sid);
    // F0c FIX: the audit-unavailable case BLOCKS (exit 2) with recovery text —
    // it no longer aborts silently (the old bug surfaced exit 0 + no message).
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('audit could not run');
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).not.toBe('researched');
  });

  it('SCOPE audit UNRESOLVED → WARN (exit 0), distinct from the spawn-failure BLOCK', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAuditOutcomes(
      'VERDICT: UNRESOLVED\n- guess at foo',
      'VERDICT: SPEC_COMPLETE',
    );
    const sid = 'cf-f0c-scope-unresolved';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    const res = await dispatchEvent(researchWithContent, [pack], reg, sid);
    expect(res.exitCode).toBe(0); // content-fail warns, does not hard-block
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).not.toBe('researched');
  });

  it('SCOPE audit GUESS_FREE still advances to researched (regression)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAuditOutcomes('VERDICT: GUESS_FREE', 'VERDICT: SPEC_COMPLETE');
    const sid = 'cf-f0c-scope-pass';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    const res = await dispatchEvent(researchWithContent, [pack], reg, sid);
    expect(res.exitCode).toBe(0);
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('researched');
  });

  it('AUTHOR audit spawn-failure → BLOCK (exit 2), FSM stays spec_authored, TaskCreate blocked', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAuditOutcomes('VERDICT: GUESS_FREE', 'THROW');
    const sid = 'cf-f0c-spec-unavailable';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    await dispatchEvent(researchWithContent, [pack], reg, sid); // → researched
    const res = await dispatchEvent(specWithContent, [pack], reg, sid); // spec_drafted → audit THROW → block
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('audit could not run');
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('spec_authored');
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(2); // not spec_complete → blocked
  });
});

describe('builtin coding-flow pack — SCOPE gating: advance coupled to content (AF.1)', () => {
  let tempHome: string;
  let priorHome: string | undefined;
  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-af1-'));
    process.env.OPENSQUID_HOME = tempHome;
  });
  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  const research = (content: string): ToolCallEvent => ({
    kind: 'tool_call',
    tool: 'Write',
    args: { file_path: 'docs/research/x-pre-research-2026-06-04.md', content },
  });

  it('BLOCKS the advance while an OPEN QUESTION is unresolved (answer it in scope)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE'); // research audit → GUESS_FREE
    const sid = 'cf-af1-openq';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    const r = await dispatchEvent(
      research('# Pre-research\n\nOPEN QUESTION: which approach?'),
      [pack],
      reg,
      sid,
    );
    expect(r.exitCode).toBe(2);
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).not.toBe('researched');
  });

  it('BLOCKS the advance on shallow research (depth < 3)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE');
    const sid = 'cf-af1-shallow'; // no depth seeded → count 0
    const r = await dispatchEvent(
      research('# Pre-research\n\nDerived from src/foo.ts:1.'),
      [pack],
      reg,
      sid,
    );
    expect(r.exitCode).toBe(2);
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).not.toBe('researched');
  });

  it('ADVANCES only when GUESS_FREE + no open question + depth >= 3', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE');
    const sid = 'cf-af1-ok';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    const r = await dispatchEvent(
      research('# Pre-research\n\nDerived from src/foo.ts:1.'),
      [pack],
      reg,
      sid,
    );
    expect(r.exitCode).toBe(0);
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('researched');
  });

  it('AF.2: the persisted SCOPE design reaches the AUTHOR coverage audit (spec-vs-design)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    // Stub passes the AUTHOR audit ONLY if the spec-audit prompt carries the persisted
    // design marker — proving the 100%-coverage check actually sees the SCOPE design.
    const r = new FunctionRegistry();
    registerEventFunctions(r);
    registerFsmFunctions(r);
    registerStateFunctions(r);
    registerVerdictFunctions(r);
    r.register(HasGeneratedSpec);
    r.register(SessionToolHistory);
    r.register(EffectiveContent);
    r.register({
      name: 'subagent_call',
      argSchema: z.object({
        model: z.string(),
        prompt: z.string(),
        timeout_ms: z.number().optional(),
      }),
      durable: false,
      execute: (a: { prompt: string }) =>
        Promise.resolve(
          ok(
            a.prompt.includes('NEVER-GUESS')
              ? 'VERDICT: GUESS_FREE'
              : a.prompt.includes('DESIGN-MARKER-XYZ')
                ? 'VERDICT: SPEC_COMPLETE'
                : 'VERDICT: INCOMPLETE',
          ),
        ),
    });
    const sid = 'cf-af2-coverage';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    await dispatchEvent(research('# Pre-research with DESIGN-MARKER-XYZ'), [pack], r, sid); // → researched + persist design
    await dispatchEvent(
      {
        kind: 'tool_call',
        tool: 'Write',
        args: { file_path: 'docs/tasks/T-x.md', content: '### Task X.1' },
      },
      [pack],
      r,
      sid,
    ); // spec write → coverage audit must SEE the design marker → SPEC_COMPLETE
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('spec_complete');
  });
});

describe('builtin coding-flow pack — pause-gates (AF.6 + GF.6 hard-block)', () => {
  let tempHome: string;
  let tempTasks: string;
  let priorHome: string | undefined;
  let priorTasks: string | undefined;
  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    priorTasks = process.env.OPENSQUID_HARNESS_TASKS_DIR;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-af6-'));
    tempTasks = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-af6-tasks-'));
    process.env.OPENSQUID_HOME = tempHome;
    process.env.OPENSQUID_HARNESS_TASKS_DIR = tempTasks; // isolate open_task_count from ~/.claude/tasks
  });
  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    if (priorTasks === undefined) delete process.env.OPENSQUID_HARNESS_TASKS_DIR;
    else process.env.OPENSQUID_HARNESS_TASKS_DIR = priorTasks;
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempTasks, { recursive: true, force: true });
  });

  const askQuestion: ToolCallEvent = { kind: 'tool_call', tool: 'AskUserQuestion', args: {} };
  const scopePrompt: PromptSubmitEvent = { kind: 'prompt_submit', prompt: 'scope a new task' };
  const stop = { kind: 'stop', assistantText: '' } as const;

  async function putPendingTask(sid: string, id: string): Promise<void> {
    const dir = join(tempTasks, sid);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${id}.json`),
      JSON.stringify({ id, subject: 'wip', status: 'pending' }),
      'utf8',
    );
  }
  // research (depth + GUESS_FREE) → researched; spec write (audit INCOMPLETE) → spec_authored.
  async function toSpecAuthored(pack: Awaited<ReturnType<typeof loadPack>>, sid: string) {
    const reg = registryWithAudit('VERDICT: INCOMPLETE');
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    await dispatchEvent(researchWithContent, [pack], reg, sid);
    await dispatchEvent(writeSpec, [pack], reg, sid);
    return reg;
  }
  async function toResearched(pack: Awaited<ReturnType<typeof loadPack>>, sid: string) {
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE');
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    await dispatchEvent(researchWithContent, [pack], reg, sid); // → researched
    return reg;
  }
  async function drivePhasesComplete(pack: Awaited<ReturnType<typeof loadPack>>, sid: string) {
    const now = '2026-06-04T00:00:00.000Z';
    for (const ev of [
      'scope_start',
      'research_done',
      'spec_drafted',
      'spec_verified',
      'tasks_loaded',
      'phase_started',
      'phases_done',
    ])
      await advanceFsmState(sid, 'coding-flow', pack.fsm!, ev, now); // → phases_complete
  }

  it('GF.6: AskUserQuestion past SCOPE → BLOCK (exit 2)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-af6-q';
    const reg = await toSpecAuthored(pack, sid); // → spec_authored (past SCOPE)
    const r = await dispatchEvent(askQuestion, [pack], reg, sid);
    expect(r.exitCode).toBe(2); // GF.6: hard-block, not warn
    expect(r.stderr).toMatch(/DRIFT/);
  });

  it('AskUserQuestion DURING SCOPE → allowed (no drift)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-af6-qok';
    await dispatchEvent(scopePrompt, [pack], reg, sid); // → scoping
    const r = await dispatchEvent(askQuestion, [pack], reg, sid);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/DRIFT/);
  });

  it('GF.6: pause/permission language stays WARN (exit 0, surfaced) — a retrospective detector', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-af6-lang';
    await dispatchEvent(scopePrompt, [pack], reg, sid); // → scoping (run active)
    const r = await dispatchEvent(
      { kind: 'prompt_submit', prompt: 'next', priorAssistantText: 'should i continue?' },
      [pack],
      reg,
      sid,
    );
    expect(r.exitCode).toBe(0); // not block — blocking the next tool wouldn't undo the pause
    expect(r.stderr).toMatch(/DRIFT/);
  });

  // G-b (T-FLOW-REARM-GATE-HOLES / RH.2): the decision-deferral class is now caught.
  it('G-b: decision-deferral language ("your call" / "unless you redirect") → WARN (not block)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    for (const prior of [
      'Take any of these into a track? your call.',
      'I can do it, unless you redirect.',
      'Let me know which of these you want.',
      'Done — which one of these next, or none of these?',
    ]) {
      const reg = registry();
      const sid = `cf-gb-${prior.length}`;
      await dispatchEvent(scopePrompt, [pack], reg, sid); // → scoping (run active)
      const r = await dispatchEvent(
        { kind: 'prompt_submit', prompt: 'next', priorAssistantText: prior },
        [pack],
        reg,
        sid,
      );
      expect(r.exitCode).toBe(0); // WARN, never block (retrospective detector)
      expect(r.stderr).toMatch(/DRIFT/);
    }
  });

  it('GF.6: Stop mid-run (spec_authored) → BLOCK (exit 2)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-af6-stop';
    const reg = await toSpecAuthored(pack, sid); // → spec_authored
    const r = await dispatchEvent(stop, [pack], reg, sid);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/DRIFT/);
  });

  it('GF.6: Stop at researched (SCOPE done, AUTHOR owed) → BLOCK (exit 2)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-af6-stop-res';
    const reg = await toResearched(pack, sid); // → researched
    const r = await dispatchEvent(stop, [pack], reg, sid);
    expect(r.exitCode).toBe(2);
  });

  it('GF.6: Stop at idle → allowed (run not started)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-af6-stop-idle';
    const r = await dispatchEvent(stop, [pack], registry(), sid);
    expect(r.exitCode).toBe(0);
  });

  it('GF.6: Stop at phases_complete with 0 open tasks → allowed (depletion auto-OFF)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-af6-stop-depleted';
    await drivePhasesComplete(pack, sid); // → phases_complete, no harness tasks → 0 open
    const r = await dispatchEvent(stop, [pack], registry(), sid);
    expect(r.exitCode).toBe(0);
  });

  it('GF.6: Stop at phases_complete with open tasks → BLOCK (backlog not depleted)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-af6-stop-open';
    await drivePhasesComplete(pack, sid); // → phases_complete
    await putPendingTask(sid, 'next-1'); // open.count > 0
    const r = await dispatchEvent(stop, [pack], registry(), sid);
    expect(r.exitCode).toBe(2);
  });

  // G-a (T-FLOW-REARM-GATE-HOLES / RH.1): a PLAIN-LANGUAGE prompt at a depleted
  // phases_complete must re-arm SCOPE without any keyword — otherwise the FSM stays
  // parked at phases_complete, run-active reads FALSE, and the pause-gates stay OFF.
  // Observable proof of the re-arm: AskUserQuestion is hard-blocked past SCOPE but
  // ALLOWED in scoping, so it flips exit 2 → 0 once the new track re-arms.
  it('G-a: a PLAIN-LANGUAGE prompt at depleted phases_complete re-arms SCOPE (no keyword)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-ga-rearm';
    const reg = registry();
    await drivePhasesComplete(pack, sid); // → phases_complete, 0 open
    // baseline: past SCOPE → a question is hard-blocked.
    expect((await dispatchEvent(askQuestion, [pack], reg, sid)).exitCode).toBe(2);
    // a plain-language new-work prompt — matches NONE of spec/scope/new task/add/design/plan.
    await dispatchEvent(
      { kind: 'prompt_submit', prompt: 'the null handling is broken — make it robust' },
      [pack],
      reg,
      sid,
    );
    // re-armed to scoping (interactive) → the same question is now allowed.
    expect((await dispatchEvent(askQuestion, [pack], reg, sid)).exitCode).toBe(0);
  });

  // G-a loop-safety: the structural re-arm is gated on open==0, so a plain prompt while
  // the backlog is NON-empty must NOT re-arm — handoff-task-complete still owns the loop
  // (it fires only at st == phases_complete).
  it('G-a: a plain prompt at phases_complete WITH open tasks does NOT re-arm (loop intact)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-ga-loop';
    const reg = registry();
    await drivePhasesComplete(pack, sid); // → phases_complete
    await putPendingTask(sid, 'next-1'); // open.count > 0
    await dispatchEvent({ kind: 'prompt_submit', prompt: 'continue' }, [pack], reg, sid);
    // still phases_complete (NOT re-armed) → AskUserQuestion stays blocked.
    expect((await dispatchEvent(askQuestion, [pack], reg, sid)).exitCode).toBe(2);
  });
});

const gitCommit: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Bash',
  args: { command: 'git commit -m "x"' },
};

function registryExec(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerFsmFunctions(r); // FU.1: the commit gate consults read_fsm_state (mid-flow → not ad-hoc)
  registerVerdictFunctions(r);
  r.register(HasActiveTask);
  r.register(WorkflowPhasesComplete);
  return r;
}

describe('builtin coding-flow pack — EXECUTE content gate (phase-logged-before-commit, FU.9)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cf-exec-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('ad-hoc commit (no active task) passes', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(gitCommit, [pack], registryExec(), 'cf-exec-noactive');
    expect(r.exitCode).toBe(0);
  });

  it('blocks commit when the active task has incomplete phases', async () => {
    const sid = 'cf-exec-incomplete';
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-03T00:00:00.000Z',
    });
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(gitCommit, [pack], registryExec(), sid);
    expect(r.exitCode).toBe(2);
  });

  it('allows commit once all 7 phases are logged', async () => {
    const sid = 'cf-exec-complete';
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-03T00:00:00.000Z',
    });
    for (const p of REQUIRED_PHASES) await appendPhase(sid, 't1', p);
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(gitCommit, [pack], registryExec(), sid);
    expect(r.exitCode).toBe(0);
  });

  // FU.1 (T-FLOW-UNSKIPPABLE / D1): the gate seam — a commit while the FSM is MID-FLOW
  // (a track is open but not authored) must BLOCK, even with NO active task. This is the
  // hole that let a blocked TaskCreate leak code out as an "ad-hoc" commit.
  it('FU.1: a code commit while the FSM is MID-FLOW (scoping) is BLOCKED (not ad-hoc)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-exec-midflow';
    await advanceFsmState(sid, 'coding-flow', pack.fsm!, 'scope_start', '2026-06-05T00:00:00.000Z'); // → scoping
    const r = await dispatchEvent(gitCommit, [pack], registryExec(), sid);
    expect(r.exitCode).toBe(2); // mid-flow ⇒ not ad-hoc ⇒ blocked
    expect(r.stderr).toMatch(/MID-FLOW/);
  });

  // FU.1 (the real root cause): a COMPOUND command `cd <dir> && git commit` is how every
  // commit is actually made (the Bash tool resets cwd). The old `^git…commit` anchor let it
  // EVADE the gate. The matcher must catch `git commit` anywhere in the command.
  it('FU.1: a COMPOUND `cd && git commit` while mid-flow is BLOCKED (anchor evasion closed)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-exec-compound';
    await advanceFsmState(sid, 'coding-flow', pack.fsm!, 'scope_start', '2026-06-05T00:00:00.000Z'); // → scoping
    const compound: ToolCallEvent = {
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'cd /repo && git commit -m "x"' },
    };
    const r = await dispatchEvent(compound, [pack], registryExec(), sid);
    expect(r.exitCode).toBe(2); // would have been 0 (evaded) under the ^-anchor
    expect(r.stderr).toMatch(/MID-FLOW/);
  });

  it('FU.1: a genuine ad-hoc commit at phases_complete (no open track) still passes', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-exec-adhoc-complete';
    const now = '2026-06-05T00:00:00.000Z';
    for (const ev of [
      'scope_start',
      'research_done',
      'spec_drafted',
      'spec_verified',
      'tasks_loaded',
      'phase_started',
      'phases_done',
    ])
      await advanceFsmState(sid, 'coding-flow', pack.fsm!, ev, now); // → phases_complete
    const r = await dispatchEvent(gitCommit, [pack], registryExec(), sid);
    expect(r.exitCode).toBe(0); // phases_complete + no active task = real ad-hoc, allowed
  });

  it('AF.3: at phases_complete, the prompt_submit handoff DIRECTS the report + next task', async () => {
    const sid = 'cf-af3';
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-04T00:00:00.000Z',
    });
    for (const p of REQUIRED_PHASES) await appendPhase(sid, 't1', p); // phases.complete == true
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const now = '2026-06-04T00:00:00.000Z';
    for (const ev of [
      'scope_start',
      'research_done',
      'spec_drafted',
      'spec_verified',
      'tasks_loaded',
      'phase_started',
      'phases_done',
    ]) {
      await advanceFsmState(sid, 'coding-flow', pack.fsm!, ev, now); // → phases_complete
    }
    const reg = registry();
    reg.register(WorkflowPhasesComplete);
    const r = await dispatchEvent({ kind: 'prompt_submit', prompt: 'next' }, [pack], reg, sid);
    expect(r.directives.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.directives)).toMatch(/report|TaskUpdate|topic 15|chat_send/i);
  });
});

const taskUpdateInProgress: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'TaskUpdate',
  args: { status: 'in_progress', taskId: 'X.1' },
};

function registryTaskStart(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerFsmFunctions(r);
  registerVerdictFunctions(r);
  r.register(HasGeneratedSpec);
  return r;
}

describe('builtin coding-flow pack — task-start hook (FU.11)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cf-tstart-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('task_unscoped resets to scoping from ANY state (the wildcard)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'phases_complete', 'task_unscoped')).toMatchObject({
      next: 'scoping',
      transitioned: true,
    });
    expect(step(pack.fsm!, 'spec_complete', 'task_unscoped')).toMatchObject({ next: 'scoping' });
  });

  // GF.7 (F10): a completed run re-arms the SCOPE gate on a fresh scope_start, but ONLY
  // from the terminal state — a mid-run scope_start stays put (no accidental reset).
  it('GF.7: phases_complete re-arms to scoping on scope_start; mid-run scope_start is a no-op', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'phases_complete', 'scope_start')).toMatchObject({
      next: 'scoping',
      transitioned: true,
    });
    // existing entry path unchanged
    expect(step(pack.fsm!, 'idle', 'scope_start')).toMatchObject({ next: 'scoping' });
    // mid-run states do NOT reset on a stray scope keyword
    expect(step(pack.fsm!, 'spec_authored', 'scope_start')).toMatchObject({
      next: 'spec_authored',
      transitioned: false,
    });
    expect(step(pack.fsm!, 'researching', 'scope_start')).toMatchObject({
      next: 'researching',
      transitioned: false,
    });
  });

  it('activating an UNSCOPED task resets the FSM to scoping + nudges', async () => {
    const sid = 'cf-tstart-unscoped';
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-03T00:00:00.000Z',
    });
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    await dispatchEvent(taskUpdateInProgress, [pack], registryTaskStart(), sid);
    // The RESET is the enforcement — it re-arms scope-before-code for the new task.
    // (The directive nudge, profession: scope-architect, surfaces live where that
    // persona pack is loaded; in this isolated pack it is dropped by profession
    // validation, so we assert the robust half: the reset.)
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('scoping');
  });

  it('activating a SCOPED task does NOT reset (no directive)', async () => {
    const sid = 'cf-tstart-scoped';
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-03T00:00:00.000Z',
      spec: resolve('package.json'),
    });
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(taskUpdateInProgress, [pack], registryTaskStart(), sid);
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('idle');
    expect(r.directives.length).toBe(0);
  });
});

const logPhase = (phase: string): ToolCallEvent => ({
  kind: 'tool_call',
  tool: 'mcp__opensquid__log_phase',
  args: { phase },
});

function registryPhaseAudit(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerVerdictFunctions(r);
  r.register(SessionToolHistory);
  r.register(EffectiveContent);
  return r;
}

describe('builtin coding-flow pack — phase-audit (FU.10)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cf-pa-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('blocks log_phase(code) with no Write/Edit this turn', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(logPhase('code'), [pack], registryPhaseAudit(), 'cf-pa-noev');
    expect(r.exitCode).toBe(2);
  });

  it('allows log_phase(code) after a Write this turn', async () => {
    const sid = 'cf-pa-ev';
    await appendTool(sid, 'Write');
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(logPhase('code'), [pack], registryPhaseAudit(), sid);
    expect(r.exitCode).toBe(0);
  });

  it('blocks log_phase(test) with no Bash this turn', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(logPhase('test'), [pack], registryPhaseAudit(), 'cf-pa-test');
    expect(r.exitCode).toBe(2);
  });

  it('always allows a judgment phase (learn — no mechanical proxy)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(logPhase('learn'), [pack], registryPhaseAudit(), 'cf-pa-learn');
    expect(r.exitCode).toBe(0);
  });
});

describe('builtin coding-flow pack — per-write scope NUDGE (FU.12 / GF.3)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cf-pw-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  // GF.3 (F4): the per-write check is now a best-effort WARN nudge (not a block) — the
  // hard guarantee is GF.2's git pre-commit/pre-push gate. These assert the nudge fires
  // (exit 0 + surfaced), not a block.
  it('nudges (warn) a code write with NO active task even when the FSM is past research', async () => {
    const sid = 'cf-pw-notask';
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    await dispatchEvent(writeResearch, [pack], reg, sid); // FSM → researched
    const r = await dispatchEvent(writeCode, [pack], reg, sid); // no active task → nudge
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/scope before code/i);
  });

  it('nudges (warn) a code write whose active task has no spec', async () => {
    const sid = 'cf-pw-nospec';
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-03T00:00:00.000Z',
    });
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    await dispatchEvent(writeResearch, [pack], reg, sid); // FSM → researched, task unscoped
    const r = await dispatchEvent(writeCode, [pack], reg, sid);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/scope before code/i);
  });
});

// GF.1 (F1 + F9): the cross-pack profession handoffs. These exercise the profession
// RESOLVER (dispatch.ts) across TWO loaded packs — the path the isolation tests
// (packs=1) never crossed, which is exactly what masked F1.
describe('builtin coding-flow pack — GF.1 cross-pack profession handoffs (F1 + F9)', () => {
  let tempHome: string;
  let priorHome: string | undefined;
  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-gf1-'));
    process.env.OPENSQUID_HOME = tempHome;
  });
  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('GF.1 (F1): task-spec-author loads as a profession pack with a team', async () => {
    const tsa = await loadPack(resolve('packs/builtin', 'task-spec-author'));
    expect(tsa.usage).toBe('profession');
    expect(tsa.team).toBeDefined();
  });

  it('GF.1 (F1): the SCOPE→AUTHOR handoff RESOLVES across packs (not dropped wrong-usage)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const tsa = await loadPack(resolve('packs/builtin', 'task-spec-author'));
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE');
    const sid = 'cf-gf1-handoff';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    await dispatchEvent(researchWithContent, [pack, tsa], reg, sid); // → researched
    const r = await dispatchEvent(
      { kind: 'prompt_submit', prompt: 'continue' },
      [pack, tsa],
      reg,
      sid,
    );
    // The handoff-research-to-spec directive (profession: task-spec-author) survived the
    // resolver — pre-GF.1 it was dropped `wrong-usage` (task-spec-author defaulted to active).
    expect(JSON.stringify(r.directives)).toMatch(/task-spec-author/);
  });

  it('GF.1 (F9): the re-scope nudge surfaces on a scoping-state prompt_submit', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const arch = await loadPack(resolve('packs/builtin', 'scope-architect'));
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE');
    const sid = 'cf-gf1-nudge';
    const r = await dispatchEvent(
      { kind: 'prompt_submit', prompt: 'scope and plan this work' },
      [pack, arch],
      reg,
      sid,
    );
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('scoping');
    // The nudge (profession: scope-architect) surfaces on prompt_submit — F9's directive
    // was previously emitted on tool_call (task-start) and dropped.
    expect(JSON.stringify(r.directives)).toMatch(/scope-architect/);
  });
});

describe('builtin coding-flow pack — autonomous SCOPE re-arm (T-FLOW-AUTONOMOUS-REARM)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-rearm-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  // NEGATIVE (pure FSM): scope_start is a no-op from a mid-run state, so the re-arm rule can NEVER
  // reset an in-flight run — it only takes effect at the terminal/initial boundary.
  it('scope_start is a no-op from a mid-run state but re-arms phases_complete', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'spec_authored', 'scope_start')).toMatchObject({
      next: 'spec_authored',
      transitioned: false,
    });
    expect(step(pack.fsm!, 'phases_complete', 'scope_start')).toMatchObject({
      next: 'scoping',
      transitioned: true,
    });
  });

  // POSITIVE (dispatcher): at phases_complete, a pre-research WRITE re-arms natively + advances —
  // no scripted scope_start, no prompt_submit. This is the autonomous between-slices boundary.
  it('a pre-research write at phases_complete re-arms → researched', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: GUESS_FREE'); // scope-audit returns GUESS_FREE
    const sid = `cf-rearm-${Date.now()}`;
    // Reach the terminal state a finished prior slice leaves (one advance per backbone edge).
    for (const ev of [
      'scope_start',
      'research_done',
      'spec_drafted',
      'spec_verified',
      'tasks_loaded',
      'phase_started',
      'phases_done',
    ]) {
      await advanceFsmState(sid, 'coding-flow', pack.fsm!, ev, new Date().toISOString());
    }
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('phases_complete');
    // Research DEPTH (scope-advance needs >= 3 read-only this turn), then the autonomous boundary.
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    await dispatchEvent(writeResearch, [pack], reg, sid);
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('researched');
  });
});
