/**
 * `serialize_plan` (GFR.1b) — render the PLAN artifact for the guess-free PLAN producer.
 *
 * PLAN has no doc-write artifact; its artifact is the WORK-GRAPH (issues + dependency edges) decomposing the
 * captured SCOPE. This renders that to a STABLE (sorted) text block the content-audit interpolates, so the
 * audit can judge the qualitative plan-rubric criteria (no-guess deps, on-topic, re-audit-scope) the
 * deterministic `plan_ready` facets (acyclic/complete) cannot.
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
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Injectable readers (tests pass pure stubs); defaults open the HOME store + read the captured artifact. */
export interface PlanSerializeDeps {
  scopePath: (sessionId: string) => Promise<string | null>;
  extract: (path: string) => Promise<{ authoredElements: { id: string }[] } | null>;
  wg: (sessionId: string) => Promise<{
    listIssues: () => Promise<{ id: string; title: string }[]>;
    listEdges: () => Promise<{ from: string; to: string; type: string }[]>;
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
  const issues = [...(await facade.listIssues())].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...(await facade.listEdges())].sort((a, b) =>
    `${a.from}|${a.to}|${a.type}`.localeCompare(`${b.from}|${b.to}|${b.type}`),
  );
  const scopeBlock = ext.authoredElements
    .map((e) => `- ${e.id}`)
    .sort((a, b) => a.localeCompare(b))
    .join('\n');
  const issueBlock = issues.map((i) => `- ${i.id}: ${i.title}`).join('\n');
  const edgeBlock = edges.map((e) => `- ${e.from} --${e.type}--> ${e.to}`).join('\n');
  const text = `SCOPE ELEMENTS (the universe the plan must cover):\n${scopeBlock}\n\nWORK-GRAPH ISSUES:\n${issueBlock}\n\nDEPENDENCY EDGES:\n${edgeBlock}\n`;
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
