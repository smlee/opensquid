/**
 * GR.2 — the typed-exit contract for a gated-ralph lap (Inv 5: ONE typed exit).
 *
 * A lap is a headless `claude -p … --output-format json` run of `RALPH.md`. Its envelope is the
 * empirically-verified shape `{ result, is_error, subtype, total_cost_usd, … }` (verified 2026-06-13).
 * The lap signals its outcome by emitting a single greppable line in `result`:
 *
 *     RALPH-EXIT: {"kind":"HUMAN_REQUIRED","reason":"SCOPE_FORK","payload":{…}}
 *
 * `parseLapOutcome` is a TOTAL mapping of every envelope shape to a `LapOutcome` — it never throws and
 * never returns a false `SHIPPED`: an unparseable envelope or `is_error` becomes `CRASH`; a clean
 * envelope with no tag becomes `SHIPPED`. The orchestrator (GR.4) switches on the result.
 *
 * Imported by: src/runtime/ralph/orchestrator.ts (GR.4), src/runtime/ralph/supervisor.ts (GR.3).
 */

/** The only escalation vocabulary — every human-required exit is one of these (Inv 5/8). */
export type HumanRequiredReason =
  | 'IRREVERSIBLE_BOUNDARY'
  | 'SCOPE_FORK'
  | 'UNRECOVERABLE_WEDGE'
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
 * `LapOutcome`. Returns null when there is no well-formed tag (caller defaults to SHIPPED on a clean
 * exit). Defensive by construction — a malformed tag is treated as "no tag".
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

/** Parse the headless JSON envelope into a total `LapOutcome` + the lap's cost. Never throws. */
export function parseLapOutcome(stdout: string): { outcome: LapOutcome; costUsd: number } {
  let env: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== 'object')
      return { outcome: { kind: 'CRASH' }, costUsd: 0 };
    env = parsed as Record<string, unknown>;
  } catch {
    return { outcome: { kind: 'CRASH' }, costUsd: 0 }; // unparseable envelope = CRASH, never SHIPPED
  }
  const costUsd = typeof env.total_cost_usd === 'number' ? env.total_cost_usd : 0;
  if (env.is_error === true) return { outcome: { kind: 'CRASH' }, costUsd };
  const tagged = extractTypedExit(typeof env.result === 'string' ? env.result : '');
  return { outcome: tagged ?? { kind: 'SHIPPED' }, costUsd }; // clean exit, no tag = SHIPPED
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
