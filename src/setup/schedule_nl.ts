/**
 * Natural-language → cron expression translator. (`SCHED.3`)
 *
 * Pipeline: bounded NL input → escape into prompt template → dispatch through
 * the user's `fast_classifier` alias → first-line trim → 6-field-strip →
 * `node-cron.validate()` → return `{ cron, timezone?, nl_input, confidence }`.
 *
 * Model-neutrality contract (per `feedback_stop_haiku_drift` +
 * `project_opensquid_model_neutral_subagent_primitive`):
 *
 *   - NO vendor model id, no provider name, no host binary name appears in
 *     this file. The user's `models.yaml` maps the abstract alias name
 *     (default `fast_classifier`) to a concrete strategy.
 *   - Audit grep `haiku|sonnet|opus|gpt-[0-9]|claude-[0-9]|gemini` against
 *     this file must return zero hits.
 *
 * Prompt-engineering shape (locked per task spec):
 *
 *   - 5-field POSIX output ONLY. The prompt explicitly names "5-field POSIX
 *     cron", and we post-process to defend against models that ignore that.
 *   - "Output ONLY the cron expression with no other text" suffix —
 *     constrains chatter even on models that aren't instruction-tuned for
 *     this shape.
 *   - 4 worked examples covering minute-level + hourly + day-level + DOW
 *     filter — empirically the minimum spread that gets mid-size models to
 *     converge.
 *   - UTC default — most schedule consumers run in UTC; we add a separate
 *     `timezone` field if the NL input mentions one.
 *
 * Temperature / max_tokens: the spec wanted to set temperature=0.0 +
 * max_tokens=64 in the dispatch options. The current `ModelStrategy.call`
 * signature is `(prompt, { timeoutMs? })` — see `src/models/types.ts`. The
 * provider-specific knobs (`temperature`, `max_tokens`) are not yet plumbed
 * through. We document the intent in the prompt itself ("Output ONLY the
 * cron expression") and structurally bound the result via the first-line
 * trim + cron-validate. A follow-up task should extend `ModelStrategy.call`
 * opts to forward these and the prompt-level guard becomes redundant.
 *
 * Prompt-injection defence (per spec risk callout):
 *
 *   - 256-char input cap rejected BEFORE we ever build the prompt.
 *   - Substitution escapes `"` → `\"` and `\` → `\\` so a hostile NL input
 *     can't break out of the quoted `"{{nl}}"` slot in the template.
 *
 * Imports from: node-cron, ../models/dispatcher.js, ../models/load_config.js,
 *   ../models/types.js.
 * Imported by: src/cli.ts (`schedule add` handler) + tests.
 */

import cron from 'node-cron';

import { resolveStrategy } from '../models/dispatcher.js';
import { loadModelsConfig } from '../models/load_config.js';

export const MAX_NL_INPUT_LEN = 256;

/**
 * Common timezone tokens we'll surface as a separate field when present in
 * the NL input. Conservative list — matching is case-insensitive, word-
 * boundary anchored. IANA names (slash-form) win when both surface; if only
 * an abbreviation appears we map it to the IANA equivalent. This is NOT a
 * complete tz database — packs requiring obscure tz names should pass a tz
 * field directly rather than rely on NL inference.
 */
const TZ_TOKEN_MAP: readonly [RegExp, string][] = [
  // IANA names — match these first so "America/New_York" doesn't get caught
  // by the `\bEST\b` rule.
  [/\b([A-Z][a-zA-Z_]+\/[A-Z][a-zA-Z_]+)\b/, ''], // sentinel — handled inline below
  [/\bUTC\b/i, 'UTC'],
  [/\bGMT\b/i, 'Etc/GMT'],
  [/\bEST\b/i, 'America/New_York'],
  [/\bEDT\b/i, 'America/New_York'],
  [/\bPST\b/i, 'America/Los_Angeles'],
  [/\bPDT\b/i, 'America/Los_Angeles'],
  [/\bCST\b/i, 'America/Chicago'],
  [/\bCDT\b/i, 'America/Chicago'],
  [/\bMST\b/i, 'America/Denver'],
  [/\bMDT\b/i, 'America/Denver'],
  [/\bJST\b/i, 'Asia/Tokyo'],
  [/\bKST\b/i, 'Asia/Seoul'],
  [/\bIST\b/i, 'Asia/Kolkata'],
  [/\bBST\b/i, 'Europe/London'],
  [/\bCET\b/i, 'Europe/Paris'],
  [/\bCEST\b/i, 'Europe/Paris'],
];

export interface NlScheduleResult {
  cron: string;
  timezone?: string;
  nl_input: string;
  confidence: 'high' | 'medium' | 'low';
}

export class InvalidScheduleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduleInputError';
  }
}

export class InvalidCronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCronError';
  }
}

// Prompt template. `{{nl}}` is the single substitution slot, wrapped in
// double quotes so a single escape pass (see `safeSubstitute`) is enough to
// neutralise hostile input.
export const PROMPT_TEMPLATE = `Convert the natural-language schedule into a 5-field POSIX cron expression.
Input: "{{nl}}"
Output ONLY the cron expression with no other text. Use UTC unless input specifies a timezone.
Examples:
- "every Monday morning around 9" -> "0 9 * * 1"
- "every 5 minutes" -> "*/5 * * * *"
- "daily at noon" -> "0 12 * * *"
- "every weekday at 6pm" -> "0 18 * * 1-5"`;

/**
 * Escape backslash + double-quote in NL input before substitution. Order
 * matters: replace `\` first so the `\"` we emit doesn't get double-escaped.
 */
export function safeSubstitute(template: string, nl: string): string {
  const escaped = nl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return template.replace('{{nl}}', escaped);
}

/**
 * Detect a timezone token in the ORIGINAL NL input (not in the model output —
 * the model is instructed to emit cron only). IANA `Region/City` form wins;
 * abbreviations map via `TZ_TOKEN_MAP`. Returns `undefined` if nothing
 * matches, in which case the caller defaults to UTC implicitly.
 */
export function detectTimezone(input: string): string | undefined {
  // IANA slash-form first — direct return of the match.
  const ianaMatch = /\b([A-Z][a-zA-Z_]+\/[A-Z][a-zA-Z_]+)\b/.exec(input);
  if (ianaMatch) return ianaMatch[1];

  for (const [pattern, iana] of TZ_TOKEN_MAP) {
    if (iana === '') continue; // skip the IANA sentinel
    if (pattern.test(input)) return iana;
  }
  return undefined;
}

/**
 * 5-field POSIX cron validator. Defends against 6-field (seconds-first)
 * shapes by stripping the leading field IF the trailing 5 fields validate,
 * else returning `null`.
 */
export function normalizeCronOutput(raw: string): string | null {
  const firstLine = raw.trim().split('\n')[0]?.trim() ?? '';
  if (firstLine === '') return null;

  const fields = firstLine.split(/\s+/);
  if (fields.length === 5) {
    return cron.validate(firstLine) ? firstLine : null;
  }
  if (fields.length === 6) {
    // Seconds-first Quartz-style. Strip leading field, re-validate.
    const fiveField = fields.slice(1).join(' ');
    return cron.validate(fiveField) ? fiveField : null;
  }
  return null;
}

export interface NlToCronOptions {
  /** Override the alias the dispatcher resolves. Defaults to `fast_classifier`. */
  alias?: string;
  /** Per-call dispatch timeout. Defaults to 10 s — model output is < 64 tokens. */
  timeoutMs?: number;
}

export async function nlToCron(
  input: string,
  options: NlToCronOptions = {},
): Promise<NlScheduleResult> {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new InvalidScheduleInputError('NL schedule input is empty');
  }
  if (input.length > MAX_NL_INPUT_LEN) {
    throw new InvalidScheduleInputError(
      `NL schedule input exceeds ${String(MAX_NL_INPUT_LEN)}-char cap (got ${String(input.length)})`,
    );
  }

  const alias = options.alias ?? 'fast_classifier';
  const cfg = await loadModelsConfig();
  const aliasCfg = cfg[alias];
  if (!aliasCfg) {
    throw new InvalidScheduleInputError(
      `Unknown model alias "${alias}" — declare it in models.yaml`,
    );
  }

  const strategy = resolveStrategy(alias, aliasCfg);
  const prompt = safeSubstitute(PROMPT_TEMPLATE, input);

  const timeoutMs = options.timeoutMs ?? 10_000;
  const raw = await strategy.call(prompt, { timeoutMs });

  const cronExpr = normalizeCronOutput(raw);
  if (cronExpr === null) {
    throw new InvalidCronError(
      `Model output "${raw.trim().split('\n')[0] ?? ''}" is not a valid 5-field POSIX cron expression`,
    );
  }

  const timezone = detectTimezone(input);
  const result: NlScheduleResult = {
    cron: cronExpr,
    nl_input: input,
    confidence: 'high',
  };
  if (timezone !== undefined) result.timezone = timezone;
  return result;
}
