/**
 * T2.4 — the deterministic SCOPE evidence (zero LLM).
 *
 * The three facets the `fullstack-flow` SCOPE gate predicates on:
 *   anchorsOk     = the ANTI-DRIFT verdict — every scoped element traces to the captured ask (checkAnchors over
 *                   the ask-verified anchor universe yields zero drift). COORDINATED with T-anti-drift-gate.md
 *                   (AD.1/AD.3/AD.4) — reuses the SHIPPED captured_ask / anchor_universe / anchors substrate
 *                   (pre-research §5: "shares the substrate — coordinate, don't duplicate").
 *   depth         = the count of research tool-calls (recall/Read/Grep) in the `since_scope_start` window —
 *                   per-task research depth (principle 9), NOT the current turn or whole session.
 *   openQuestion  = an unchecked `- [ ] OPEN QUESTION` line remains in the artifact.
 *
 * The artifact path comes from the LIVE advance event (`buildGuardCtx`), so there is no same-pass
 * read-after-write dependency on a persisted key. FAIL-CLOSED on a missing artifact (→ not-ready).
 *
 * Spec: docs/tasks/T-v2-track2-discipline.md T2.4 ("Key code shapes").
 */
import { readFile } from 'node:fs/promises';

import { checkAnchors } from '../coverage/anchors.js';
import { buildAnchorUniverse } from '../coverage/anchor_universe.js';
import { readCapturedAsk } from '../coverage/captured_ask.js';
import { readSessionToolLedger } from '../session_state.js';

import { extractScope } from './scope_extract.js';

/** The research tool-calls that count toward SCOPE depth. */
const RESEARCH = new Set(['mcp__opensquid__recall', 'Read', 'Grep']);

/** An unchecked `- [ ] OPEN QUESTION` marker anywhere in the artifact (case-insensitive, multiline). */
const OPEN_Q = /^\s*-\s*\[ \]\s*open[ _-]?question/im;

export interface ScopeEvidence {
  anchorsOk: boolean;
  depth: number;
  openQuestion: boolean;
}

/**
 * Compute the SCOPE evidence for `artifactPath`. FAIL-CLOSED: a missing artifact → `{false, 0, false}` (the
 * gate blocks). Deterministic given the disk + ledger state.
 */
export async function scopeEvidence(
  sessionId: string,
  artifactPath: string,
): Promise<ScopeEvidence> {
  const ext = await extractScope(artifactPath);
  if (ext === null) return { anchorsOk: false, depth: 0, openQuestion: false }; // fail-closed
  // anchors-resolve = the anti-drift verdict over the ask-verified universe. buildAnchorUniverse VERIFIES each
  // design-id's askSpan as a verbatim substring of the captured ask, then admits ITS leaves — so an element off
  // the ask is drift (the regex-incident fix). Reuses the SHIPPED coverage substrate (no duplication).
  const ask = await readCapturedAsk(sessionId);
  const universe = buildAnchorUniverse({
    askText: ask.turns.join('\n'),
    scopeElements: ext.scopeElements,
    tasks: ext.tasks,
  });
  const anchorsOk = checkAnchors(ext.authoredElements, universe).drift.length === 0;
  // depth from the per-task `since_scope_start` window (session_state.ts:288 — `tools` IS `ledger.sinceScope`).
  const { tools } = await readSessionToolLedger(sessionId, 'since_scope_start');
  const depth = tools.filter((t) => RESEARCH.has(t)).length;
  // fail-OPEN on a read error here, but an unreadable artifact yields no open-q hit → the OTHER facets still
  // gate (a truly-absent artifact already returned the fail-closed default above).
  const text = await readFile(artifactPath, 'utf8').catch(() => '');
  return { anchorsOk, depth, openQuestion: OPEN_Q.test(text) };
}
