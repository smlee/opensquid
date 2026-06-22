/**
 * ORCH.2 — `classify(prompt, ctx)`: the one fuzzy step of the hard-coded prompt router.
 *
 * Emits the SAME frozen facet vocabulary a pack's `serves` declares (`packs/schemas/pack_v2.ts`), so the matcher
 * (ORCH.3) can route a turn to a pack. PURE + cheap-first deterministic (no Date/Math). Two anti-drift rules
 * from the locked design:
 *   - `domain` is NEVER decided here — it is COPIED from `ctx.domain` (the project's declared dictionary value,
 *     ORCH.4), so the model can't coin a domain word.
 *   - `stakes:'high'` is emitted ONLY on a side-effect signal (run/deploy/send/…) — the irreversible turns we
 *     over-gate; `produce`/`inform`/etc. carry no auto-stakes.
 * Safe default: an ambiguous/empty prompt → `inform` + `confidence:'low'` (→ the grounded floor, never a
 * confident wrong pack).
 *
 * NOTE (deviation from the ORCH.2 spec's "re-point classifyRequestType as a derived view"): the legacy
 * `request_type.ts` classifier is left UNTOUCHED. Its `confidence` axis means "confidence it's research-vs-work";
 * this classifier's `confidence` means "confidence in the intent" — a bare ack ("ok") is confidently `converse`
 * here but no-signal `research/low` there, so a single engine cannot reproduce the legacy confidence. Keeping the
 * two independent is the simplest CORRECT choice (guaranteed parity, no live-gate behavior change); the minor
 * regex overlap is the accepted cost.
 *
 * Imported by: src/runtime/loop/orchestrate.ts (ORCH.5).
 */
import type { MacroIntent, DomainDict } from '../packs/schemas/pack_v2.js';

export interface ClassifyCtx {
  project: boolean;
  /** the project's declared domain (ORCH.4) — copied straight onto the facets; the classifier never coins one. */
  domain?: DomainDict;
}

export interface Facets {
  intent: MacroIntent;
  domain?: DomainDict;
  stakes?: 'low' | 'high';
  project: boolean;
  confidence: 'high' | 'low';
}

// Precedence order matters: meta/social first, then world-effect, then the work/understand families.
const CONTROL = /\b(remember|forget|switch to|never mind|undo|set (default|preference)|stop)\b/i;
const CONVERSE = /^\s*(thanks|thank you|hi|hello|hey|got it|ok(ay)?|cool|nice|lol)\b[\s.!]*$/i;
const SIDEEFFECT = /\b(run|deploy|send|publish|push|install|execute|drop|merge)\b/i;
const WORK =
  /\b(build|add|implement|fix|refactor|write|create|ship|rename|delete|remove|migrate|wire|patch|bump|release|update|change|edit)\b/i;
const TRANSFORM = /\b(summari[sz]e|rewrite|reword|translate|reformat|convert)\b/i;
const DECIDE = /\b(should i|which|scope|plan|design|decide|choose|approach|architect)\b/i;
const LOCATE = /\b(where is|find the|locate|which file)\b/i;
const INVESTIGATE =
  /\b(why|investigate|explain|compare|review|understand|how does|what is|what'?s|whats|look|check)\b/i;

/** Cheap-first deterministic classification; `domain` mirrors ctx, `stakes:'high'` only on side-effects. */
export function classify(prompt: string, ctx: ClassifyCtx): Facets {
  const has = (re: RegExp): boolean => re.test(prompt);
  // Builder: add domain/stakes only when present (exactOptionalPropertyTypes — no present-undefined keys).
  const mk = (intent: MacroIntent, confidence: 'high' | 'low', stakes?: 'high'): Facets => {
    const f: Facets = { intent, project: ctx.project, confidence };
    if (ctx.domain !== undefined) f.domain = ctx.domain;
    if (stakes !== undefined) f.stakes = stakes;
    return f;
  };
  if (has(CONTROL)) return mk('control', 'high');
  if (has(CONVERSE)) return mk('converse', 'high');
  if (has(SIDEEFFECT)) return mk('act', 'high', 'high'); // side-effect → stakes:high
  if (has(TRANSFORM)) return mk('transform', 'high');
  if (has(DECIDE)) return mk('decide', 'high');
  if (has(LOCATE)) return mk('locate', 'high');
  if (has(WORK) && !has(INVESTIGATE)) return mk('produce', 'high');
  if (has(INVESTIGATE) && !has(WORK)) return mk('inform', 'high');
  return mk('inform', 'low'); // safe default: inform + ground
}
