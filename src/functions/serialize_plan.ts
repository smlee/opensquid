/**
 * `serialize_plan` (GFR.1b) — render the PLAN artifact for the guess-free PLAN producer.
 *
 * PLAN has no doc-write artifact; its artifact is the captured SCOPE's decomposition — the IN-SCOPE work-graph
 * ISSUES + the authored scope-element DEPENDENCIES (with their derived reasons). This renders that to a STABLE
 * (sorted) text block the content-audit interpolates, so the audit can judge the qualitative plan-rubric
 * criteria (no-guess deps, on-topic, re-audit-scope) the deterministic `plan_ready` facets cannot. (Work-graph
 * EDGE acyclicity is the deterministic gate's job via `plan_evidence`, not this artifact's — so edges are not
 * rendered here; the dependency info the audit judges is the authored scope-element deps below.)
 *
 * REUSES the shipped PLAN-evidence readers (no reinvention): `openWg` (project-bound facade) +
 * `extractScope` (the captured pre-research universe) — the same sources the deterministic PLAN gate reads.
 * Stable sort ⇒ an unchanged graph renders identically ⇒ `cached_audit`'s prompt-hash cache absorbs re-fires.
 *
 * FAIL-LOUD: no captured scope (path absent / `extractScope` → null) ⇒ `null` (the producer runs no audit ⇒
 * the cache stays absent ⇒ the PLAN gate fails closed). Never a partial/guessed artifact.
 */
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { openWg } from '../runtime/loop/plan_evidence.js';
import { sessionStateFile } from '../runtime/paths.js';
import { ok } from '../runtime/result.js';
import { extractScope } from '../runtime/loop/scope_extract.js';
import { scopeToDecomposition } from '../runtime/loop/plan_audit.js';
import { readCheckpointBySession } from '../runtime/ralph/loop_stage.js';

import type { FunctionRegistry } from './registry.js';

// The captured pre-research artifact path (stamped by v2_supply on the SCOPE advance, T2.5).
const PRE_RESEARCH_PATH_KEY = 'fullstack-flow-pre-research-path';
const MAX_PLAN = 64_000;

/** Read the captured pre-research artifact path (JSON-encoded string), or null when none/unreadable. */
async function readPreResearchPath(sessionId: string): Promise<string | null> {
  try {
    const v: unknown = JSON.parse(
      await readFile(sessionStateFile(sessionId, PRE_RESEARCH_PATH_KEY), 'utf8'),
    );
    if (typeof v === 'string' && v.length > 0) return v;
  } catch {
    // Fresh per-stage sessions restore the scope pointer from the task checkpoint below.
  }
  try {
    return (await readCheckpointBySession(sessionId))?.scopeArtifacts.at(-1) ?? null;
  } catch {
    return null;
  }
}

/** Injectable readers (tests pass pure stubs); defaults open the HOME store + read the captured artifact. */
export interface PlanSerializeDeps {
  scopePath: (sessionId: string) => Promise<string | null>;
  extract: (path: string) => Promise<{
    authoredElements: { id: string }[];
    scopeElements: { designId: string; askSpan: string; text: string }[];
    deps: { element: string; dependsOn: string; reason: string }[];
  } | null>;
  wg: (sessionId: string) => Promise<{
    listIssues: () => Promise<{ id: string; title: string; body: string }[]>;
  }>;
}

const defaultDeps: PlanSerializeDeps = {
  scopePath: readPreResearchPath,
  extract: extractScope,
  wg: openWg,
};

/** Render the work-graph + captured scope to a stable text artifact, or null when no scope is captured. */
export async function serializePlan(
  sessionId: string,
  deps: PlanSerializeDeps = defaultDeps,
): Promise<string | null> {
  const path = await deps.scopePath(sessionId);
  if (path === null) return null; // no captured scope → fail-loud (gate blocks)
  const ext = await deps.extract(path);
  if (ext === null) return null;
  const facade = await deps.wg(sessionId);
  // PROPER evaluation: render only THIS scope's decomposition — the issues stamped with a sourceElementId in
  // the universe, not the whole project namespace (the same issue-scoping the deterministic plan_evidence
  // applies, so the content-audit and the gate see the identical node set). Edges are NOT rendered (the audit
  // judges the authored scope-element deps below; work-graph edge acyclicity is the gate's job) — so pass `[]`
  // and use only `.issues`.
  const scoped = scopeToDecomposition(
    await facade.listIssues(),
    [],
    ext.authoredElements.map((e) => e.id),
  );
  const issues = [...scoped.issues].sort((a, b) => a.id.localeCompare(b.id));
  // SUBSTANCE (not bare ids): render each scope element's AUTHORED TEXT + ask-anchor so the content-audit can
  // judge on-topic + coverage; flag any element missing its ask-anchor (an un-traceable element = a guess).
  const scopeBlock = [...ext.scopeElements]
    .sort((a, b) => a.designId.localeCompare(b.designId))
    .map(
      (e) =>
        `- ${e.designId}: ${e.text}${e.askSpan ? '' : '  [⚠ NO ask-anchor — untraceable to the captured ask]'}`,
    )
    .join('\n');
  const issueBlock = issues.map((i) => `- ${i.id}: ${i.title}`).join('\n');
  // DEPENDENCIES with their DERIVED reason (what the depended-on element produces that this one consumes) — a
  // dependency with no reason is rendered as an explicit guess so the audit fails it (NEVER-GUESS).
  const depBlock = [...ext.deps]
    .sort((a, b) => `${a.element}|${a.dependsOn}`.localeCompare(`${b.element}|${b.dependsOn}`))
    .map(
      (d) =>
        `- ${d.element} depends on ${d.dependsOn} — ${d.reason || '⚠ NO REASON CITED (a guess — derive what the upstream produces that this consumes)'}`,
    )
    .join('\n');
  const text = `SCOPE ELEMENTS (the universe the plan must cover — authored text):\n${scopeBlock}\n\nDECOMPOSITION (work-graph issues covering the scope):\n${issueBlock}\n\nDEPENDENCIES (with derived reasons):\n${depBlock}\n`;
  return text.length > MAX_PLAN ? null : text; // over-cap → null (never a partial artifact)
}

export function registerSerializePlan(registry: FunctionRegistry): void {
  registry.register({
    name: 'serialize_plan',
    argSchema: z.object({}).strict(),
    durable: false,
    memoizable: false, // re-render each call so a work-graph change is reflected
    costEstimateMs: 5,
    execute: async (_args, ctx) => ok(await serializePlan(ctx.sessionId)),
  });
}
