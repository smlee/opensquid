/**
 * GR.2 — the typed-exit contract for a gated-ralph lap (Inv 5: ONE typed exit).
 *
 * A lap is a headless run of `RALPH.md` through whatever harness the config selects. Each harness adapter
 * (MHL.4/MHL.5) folds its own raw output into the NEUTRAL `LapEnvelope` (lap_harness.ts); this file owns only
 * the vendor-free half — mapping that envelope to a `LapOutcome`. The lap signals its outcome by emitting a
 * single greppable line in its result text:
 *
 *     RALPH-EXIT: {"kind":"HUMAN_REQUIRED","reason":"SCOPE_FORK","payload":{…}}
 *
 * `outcomeFromEnvelope` is a TOTAL mapping of every envelope to a `LapOutcome` — it never throws and never
 * returns a false `SHIPPED` (fail-CLOSED, Codex P1 #4): an errored envelope becomes `CRASH`; a clean envelope
 * with a valid tag becomes that tag's outcome; a clean envelope with a present-but-invalid tag becomes `WEDGE`
 * (a deterministic attempted-exit-that-produced-garbage → human); a clean envelope with NO tag becomes `CRASH`
 * (the lap may have forgotten to print it → a fresh lap can recover). SHIPPED requires an explicit well-formed
 * SHIPPED tag. The orchestrator (GR.4) switches on the result. This file carries NO vendor invocation/envelope
 * literal (audit-grep-empty, MHL.8) — those live only in the adapters (`./harnesses/*_lap_harness.ts`).
 *
 * Imported by: src/runtime/ralph/orchestrator.ts (GR.4), src/runtime/ralph/supervisor.ts (GR.3),
 * src/setup/cli/ralph.ts (the wire, MHL.6).
 */
import type { LapEnvelope } from './lap_harness.js';

/** The only escalation vocabulary — every human-required exit is one of these (Inv 5/8). */
export type HumanRequiredReason =
  | 'IRREVERSIBLE_BOUNDARY'
  | 'SCOPE_FORK'
  | 'UNRECOVERABLE_WEDGE'
  // CG.1 — the consistency-gate park reason: an item SHIPPED but no durable commit for its work landed. This
  // exists in the TYPE (orchestrator-constructible, routable through parkAndEscalate/escalateLap) but is
  // DELIBERATELY absent from HUMAN_REQUIRED_REASONS below — the gate is the SOLE authority for it, so a
  // subprocess lap can never self-declare "I committed" (spoof) nor parse/emit NO_DURABLE_COMMIT in its exit tag.
  | 'NO_DURABLE_COMMIT'
  | 'BUDGET'
  | 'RATE_BUDGET'
  | 'BOARD_EMPTY';

export type LapOutcome =
  // `stage` (T-v2-per-stage-loop PSL.3): the lap's RESULTING FSM stage at exit, reported by a per-stage lap so
  // the orchestrator can prime the NEXT stage's lap WITHOUT reading the lap's session FSM (the lap is a separate
  // subprocess; cross-session FSM reads are not guaranteed). Optional + backward-compatible: a per-ITEM lap (v1
  // coding-flow, or a fullstack-flow lap not driven per-stage) omits it → the orchestrator's open-ended path.
  | { kind: 'SHIPPED'; stage?: string }
  | { kind: 'HUMAN_REQUIRED'; reason: HumanRequiredReason; item?: string; payload?: unknown }
  | { kind: 'WEDGE' }
  | { kind: 'TIMEOUT' }
  | { kind: 'CRASH' };

const HUMAN_REQUIRED_REASONS: readonly HumanRequiredReason[] = [
  'IRREVERSIBLE_BOUNDARY',
  'SCOPE_FORK',
  'UNRECOVERABLE_WEDGE',
  'BUDGET',
  'RATE_BUDGET',
  'BOARD_EMPTY',
];

const isReason = (v: unknown): v is HumanRequiredReason =>
  typeof v === 'string' && (HUMAN_REQUIRED_REASONS as readonly string[]).includes(v);

const TAG = 'RALPH-EXIT:';

/**
 * Scan the lap's free-text result for the LAST `RALPH-EXIT: {json}` line and validate it into a
 * `LapOutcome`. Returns null when there is no well-formed tag — the caller (`outcomeFromEnvelope`)
 * classifies a null as WEDGE when a tag is present (via `tagIsPresent`) else CRASH, NEVER SHIPPED.
 * Defensive by construction — a malformed tag is treated as "no valid tag".
 */
export function extractTypedExit(resultText: string): LapOutcome | null {
  const idx = resultText.lastIndexOf(TAG);
  if (idx === -1) return null;
  const after = resultText.slice(idx + TAG.length).trimStart();
  const json = sliceFirstJsonObject(after);
  if (json === null) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  switch (rec.kind) {
    case 'SHIPPED':
      // Carry the optional resulting `stage` when a per-stage lap reports it (PSL.3); else a bare SHIPPED.
      return { kind: 'SHIPPED', ...(typeof rec.stage === 'string' ? { stage: rec.stage } : {}) };
    case 'WEDGE':
      return { kind: 'WEDGE' };
    case 'TIMEOUT':
      return { kind: 'TIMEOUT' };
    case 'CRASH':
      return { kind: 'CRASH' };
    case 'HUMAN_REQUIRED':
      if (!isReason(rec.reason)) return null; // a HUMAN_REQUIRED without a valid reason is malformed
      return {
        kind: 'HUMAN_REQUIRED',
        reason: rec.reason,
        ...(typeof rec.item === 'string' ? { item: rec.item } : {}),
        ...(rec.payload === undefined ? {} : { payload: rec.payload }),
      };
    default:
      return null;
  }
}

/**
 * FCE.1 — the locked "present" signal (pure, total). True iff the lap ATTEMPTED a structured exit: the literal
 * `RALPH-EXIT:` tag occurs anywhere in the result text, regardless of whether valid JSON follows. The fail-
 * closed fold uses this to split a null `extractTypedExit` into WEDGE (present-but-invalid, deterministic →
 * human) vs CRASH (truly absent, possibly-transient → retryable). §5-Q1 lock. Reuses the module-private `TAG`.
 */
export function tagIsPresent(resultText: string): boolean {
  return resultText.lastIndexOf(TAG) !== -1;
}

/** The lap's cost + token usage, folded from the envelope for the LSF.5 loop_metrics history (§3a). */
export interface LapUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * MHL.3 — the NEUTRAL envelope→outcome fold (the vendor-free half of the former `parseLapOutcome`). The
 * harness adapter (MHL.4/MHL.5) owns turning its raw stdout into a `LapEnvelope`; this maps that envelope to a
 * total `LapOutcome` + usage, FAIL-CLOSED (Codex P1 #4, never a default SHIPPED): `isError` ⇒ CRASH; else a
 * valid RALPH-EXIT tag ⇒ its outcome; a present-but-invalid tag ⇒ WEDGE; an absent tag ⇒ CRASH; cost/tokens
 * pass through. Never throws — vendor-free by construction.
 */
export function outcomeFromEnvelope(env: LapEnvelope): { outcome: LapOutcome } & LapUsage {
  const { costUsd, inputTokens, outputTokens } = env;
  if (env.isError) return { outcome: { kind: 'CRASH' }, costUsd, inputTokens, outputTokens };
  const tagged = extractTypedExit(env.resultText);
  // FAIL-CLOSED (never default SHIPPED): a valid tag ⇒ its outcome; a present-but-invalid tag ⇒ WEDGE
  // (deterministic garbage → human, no retry); a truly absent tag ⇒ CRASH (the lap may have forgotten to
  // print the tag; a fresh lap can recover → bounded retry). §5-Q1 split; "present" = tag occurs (locked).
  const outcome: LapOutcome =
    tagged ?? (tagIsPresent(env.resultText) ? { kind: 'WEDGE' } : { kind: 'CRASH' });
  return { outcome, costUsd, inputTokens, outputTokens };
}

/** Return the first balanced `{…}` JSON object substring starting at `s[0]`, or null. */
function sliceFirstJsonObject(s: string): string | null {
  if (!s.startsWith('{')) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}
