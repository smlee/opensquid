/**
 * GR.2 — the execution-time DECIDE-vs-ESCALATE classifier (deterministic-first).
 *
 * When a lap hits a decision, the question is: do the locked principles SETTLE it (DECIDE and proceed,
 * per [[feedback-no-questions-after-scoping]]) or is it a genuine fork / irreversible boundary that
 * needs the human (ESCALATE, per Inv 8)? This module is the cheap, deterministic FIRST layer — it fires
 * only on high-confidence signals and otherwise returns DEFER, meaning "no cheap signal → the in-lap
 * agent's own judgment decides" (the lap is already an LLM running RALPH.md; a separate `llm_classify`
 * call would be a redundant second model invocation that also needs the flows executor context — the
 * simpler-correct design defers ambiguous cases to the agent that already holds the full context).
 *
 * Inv 3 bias: DEFER resolves to DECIDE unless the agent itself raises a typed HUMAN_REQUIRED. A
 * misclassification (an escalation that was principle-settleable, or a barreled-through genuine fork)
 * is recorded as a drift event → the residual-shrink path (the classifier earns trust through the
 * existing lesson channel, never assumed correct).
 *
 * Imports from: ../drift_catalog.js.
 */
import { appendSessionDriftEvent } from '../drift_catalog.js';

export type DecisionVerdict = 'DECIDE' | 'ESCALATE' | 'DEFER';

export interface DecisionClassification {
  verdict: DecisionVerdict;
  confidence: number; // 1 = a fired deterministic signal; 0 = DEFER (no signal)
  source: 'heuristic';
  matched: string[]; // the signal tokens that fired (audit trail)
}

// Irreversible / outward-facing / human-only boundaries → ESCALATE. These ENCODE the "irreversible
// boundary" principle as deterministic signals (the unambiguous cases the agent must never decide).
const ESCALATE_SIGNALS: readonly RegExp[] = [
  /\bnpm\s+publish\b/i,
  /\bpublish\s+(?:the\s+)?(?:package|release|npm)\b/i,
  /\botp\b/i,
  /\bforce[-\s]?push\b/i,
  /\b--force(?:-with-lease)?\b/i,
  /\bdelete\s+(?:the\s+)?branch\b/i,
  /\bdrop\s+(?:table|database)\b/i,
  /\brm\s+-rf\b/i,
  /\bdeploy\s+to\s+prod(?:uction)?\b/i,
  /\bgenuine(?:ly)?\s+new\s+product\b/i,
  /\bwhich\s+(?:product|ux|business)\s+(?:direction|trade-?off)\b/i,
];

// Principle-settleable surface decisions → DECIDE (the Simplicity/style principles settle these).
const DECIDE_SIGNALS: readonly RegExp[] = [
  /\b(?:rename|naming|name)\b/i,
  /\b(?:format|prettier|lint|whitespace|indent)\b/i,
  /\b(?:typo|comment|docstring|wording)\b/i,
  /\b(?:file\s+location|which\s+directory|where\s+to\s+put)\b/i,
  /\b(?:refactor|extract|inline)\b/i,
];

function firstMatches(text: string, signals: readonly RegExp[]): string[] {
  return signals.filter((re) => re.test(text)).map((re) => re.source);
}

/**
 * Classify a decision. ESCALATE wins over DECIDE when both fire (a destructive boundary in a
 * cosmetically-worded change is still a boundary). No signal → DEFER (agent decides, Inv 3 → DECIDE).
 */
export function classifyDecision(decision: string): DecisionClassification {
  const esc = firstMatches(decision, ESCALATE_SIGNALS);
  if (esc.length > 0)
    return { verdict: 'ESCALATE', confidence: 1, source: 'heuristic', matched: esc };
  const dec = firstMatches(decision, DECIDE_SIGNALS);
  if (dec.length > 0)
    return { verdict: 'DECIDE', confidence: 1, source: 'heuristic', matched: dec };
  return { verdict: 'DEFER', confidence: 0, source: 'heuristic', matched: [] };
}

/**
 * Record a misclassification as a session drift event (the residual-shrink path). `expected` is the
 * verdict that turned out correct (e.g. the agent escalated something the heuristic called DECIDE).
 */
export async function recordMisclassification(
  sessionId: string,
  expected: DecisionVerdict,
  got: DecisionVerdict,
  decision: string,
  nowIso: string,
): Promise<void> {
  await appendSessionDriftEvent(sessionId, {
    timestamp: nowIso,
    pack: '<session>',
    ruleId: 'decision-classifier',
    level: 'surface',
    message: `MISCLASSIFIED decide-vs-escalate: expected ${expected}, got ${got} — "${decision.slice(0, 120)}"`,
  });
}
