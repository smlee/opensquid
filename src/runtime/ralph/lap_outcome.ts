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
  | 'PROCESS_PAUSED'
  // Core-generated from the trusted process-control channel. Deliberately absent from
  // HUMAN_REQUIRED_REASONS so model-authored RALPH tags cannot spoof a human cancellation.
  | 'CANCELLED_BY_HUMAN'
  // Core-only terminal availability: nonterminal work exists, but none is automation-eligible. Deliberately
  // absent from HUMAN_REQUIRED_REASONS so a model-authored lap cannot spoof the board projection.
  | 'BOARD_WAITING'
  | 'BOARD_EMPTY';

export type LapOutcome =
  // Model-authored SHIPPED never carries stage authority. The coordinator reads the exact attempt's
  // gate-accepted session receipt and persists progression itself.
  | { kind: 'SHIPPED' }
  /** Core-only: the pack checkpoint is outside its declared process-driven set. Never model-authored. */
  | { kind: 'AWAITING_INPUT'; stage: string }
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
 * Validate the lap's ONE `RALPH-EXIT: {json}` line into a `LapOutcome`. Zero tags or multiple tags return
 * null — the caller (`outcomeFromEnvelope`) classifies a present-but-invalid contract as WEDGE, never SHIPPED.
 * This enforces Inv 5 rather than silently accepting a later contradictory exit.
 */
export function extractTypedExit(resultText: string): LapOutcome | null {
  const idx = resultText.indexOf(TAG);
  if (idx === -1 || idx !== resultText.lastIndexOf(TAG)) return null;
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
      return Object.keys(rec).length === 1 ? { kind: 'SHIPPED' } : null;
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
  if (env.controlOutcome !== undefined) {
    return {
      outcome: {
        kind: 'HUMAN_REQUIRED',
        reason: env.controlOutcome.kind,
        payload: env.controlOutcome,
      },
      costUsd,
      inputTokens,
      outputTokens,
    };
  }
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
