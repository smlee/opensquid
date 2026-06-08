/**
 * Pure memory compression (retire-Rust RES-4a; port of engine compress.rs `compress`). A window of
 * memories → one summary memory `Mc` carrying `derived_from` + the summed `consumed_by_user_lessons`
 * counter. compress only INSERTS Mc — it never deletes/mutates predecessors (that is RES-4b's
 * verified, immunity-gated terminal step). The LLM summarize step uses the host's raw-text
 * `subagent_call` (the host has NO structured-output path), so this parses JSON out of the raw text
 * and runs the ported refusal/validation guards.
 *
 * Imports from: node:crypto, ./cycle.js.
 * Imported by: RES-4b (consolidate) — not yet wired.
 */
import { createHash } from 'node:crypto';

import { detectCycleInWindow } from './cycle.js';

const MAX_DESCRIPTION_CHARS = 200; // compress.rs:42
const MAX_CONTENT_CHARS = 4_000; // compress.rs:43
const MAX_DERIVED_FROM_LEN = 64; // compress.rs:44
const U32_MAX = 0xffffffff;

const COMPRESSION_PROMPT_TEMPLATE = `You are compressing a window of MEMORIES into ONE summary memory. The summary will replace the originals in the long-tail memory store.

Inputs (each item is one memory, \`--- MEMORY <id> ---\` separator):
{MEMORIES_BLOCK}

Rules:
- Preserve key facts, decisions, references, names, paths. Drop ephemera (small talk, exact timestamps, redundant repetitions).
- Do NOT invent facts not present in the inputs.
- Do NOT use praise words ("great", "excellent", "successfully") — sycophancy markers.
- description: a single-sentence summary, <=200 chars, no period at end.
- content: the compressed body. Multi-paragraph allowed. <=4000 chars.
- If the input memories are too thin / contradictory / off-topic to compose a coherent summary, return {"error": "insufficient_input"} instead.

Output as JSON matching one of:
  Success: {"description": "...", "content": "..."}
  Refusal: {"error": "insufficient_input"}`;

/** The memory row compress reads/writes — the libSQL `lessons` (source:'memory') shape EXTENDED with
 * the two compression columns. No `scope` column: scope is the `scope:<v>` tag. */
export interface MemoryRow {
  id: string;
  content: string;
  tags: string[];
  source: string;
  author: 'user' | 'agent';
  createdAt: string;
  derivedFrom: string[];
  consumedByUserLessons: number;
  embedding?: number[] | null;
}

export interface CompressDeps {
  getMemoryById: (id: string) => Promise<MemoryRow | null>;
  insertMemory: (m: MemoryRow) => Promise<void>;
  summarize: (prompt: string) => Promise<string>; // subagent_call → RAW TEXT
  embed: (text: string) => Promise<number[] | null>;
  now: () => Date;
}

/** Empty window OR an LLM refusal (an `error` key) — compress.rs maps both to InsufficientInput. */
export class CompressionInsufficientInputError extends Error {
  constructor(message = 'compress: insufficient input') {
    super(message);
    this.name = 'CompressionInsufficientInputError';
  }
}
export class CompressionScopeMismatchError extends Error {
  constructor(public readonly window: string[]) {
    super(`compress: scope mismatch across window [${window.join(', ')}]`);
    this.name = 'CompressionScopeMismatchError';
  }
}
export class CompressionParseError extends Error {
  constructor(message: string) {
    super(`compress: LLM output was not valid JSON: ${message}`);
    this.name = 'CompressionParseError';
  }
}
export class CompressionValidationError extends Error {
  constructor(message: string) {
    super(`compress: ${message}`);
    this.name = 'CompressionValidationError';
  }
}

interface CompressedDraft {
  description: string;
  content: string;
}

const scopeOf = (m: MemoryRow): string | null => m.tags.find((t) => t.startsWith('scope:')) ?? null;

function fillTemplate(preds: MemoryRow[]): string {
  let block = '';
  for (const m of preds) {
    block += `--- MEMORY ${m.id} ---\ncontent:\n${m.content.trim()}\n\n`;
  }
  return COMPRESSION_PROMPT_TEMPLATE.replace('{MEMORIES_BLOCK}', block.trim());
}

/** `error` key = refusal → InsufficientInput (compress.rs:543-545); else expect {description, content}. */
function discriminateCompressOutput(parsed: unknown): CompressedDraft {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CompressionParseError('expected a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if ('error' in obj)
    throw new CompressionInsufficientInputError('LLM refused: insufficient input');
  if (typeof obj.description !== 'string' || typeof obj.content !== 'string') {
    throw new CompressionParseError('missing description/content');
  }
  return { description: obj.description, content: obj.content };
}

/** D-Cx7 parse-time validation (compress.rs:552-591). */
function validateCompressedInvariants(draft: CompressedDraft, predecessorIds: string[]): void {
  if (draft.description.trim().length === 0)
    throw new CompressionValidationError('description empty after trim');
  if (draft.content.trim().length === 0)
    throw new CompressionValidationError('content empty after trim');
  if ([...draft.description].length > MAX_DESCRIPTION_CHARS)
    throw new CompressionValidationError(`description length > cap ${MAX_DESCRIPTION_CHARS}`);
  if ([...draft.content].length > MAX_CONTENT_CHARS)
    throw new CompressionValidationError(`content length > cap ${MAX_CONTENT_CHARS}`);
  if (predecessorIds.length === 0)
    throw new CompressionValidationError('derived_from cannot be empty for a compressed memory');
  if (predecessorIds.length > MAX_DERIVED_FROM_LEN)
    throw new CompressionValidationError(`derived_from len > cap ${MAX_DERIVED_FROM_LEN}`);
}

/** `mem-c-<16hex>` — the `-c-` infix marks a compressed memory (engine identifies via derived_from). */
function mintCompressedId(now: Date, predecessorIds: string[]): string {
  const h = createHash('sha256')
    .update(`${now.getTime()}\n${predecessorIds.join(',')}`)
    .digest('hex')
    .slice(0, 16);
  return `mem-c-${h}`;
}

/**
 * Compress a window of memory ids into one minted Mc (NO delete). Throws the typed errors above on
 * empty input, cycle/over-depth (via cycle.ts), scope mismatch, LLM refusal/parse, or invariant
 * violation. Predecessors are never mutated.
 */
export async function compress(deps: CompressDeps, ids: string[]): Promise<MemoryRow> {
  const unique = [...new Set(ids)]; // dedupe BEFORE load (compress.rs:151-155)
  if (unique.length === 0) throw new CompressionInsufficientInputError('empty window');

  const preds: MemoryRow[] = [];
  for (const id of unique) {
    const m = await deps.getMemoryById(id);
    if (m === null) throw new Error(`compress: predecessor ${id} not found`);
    preds.push(m);
  }

  // Cycle + depth across the input set (compress.rs:172).
  await detectCycleInWindow(async (id) => {
    const m = await deps.getMemoryById(id);
    return m === null ? null : m.derivedFrom;
  }, unique);

  // Scope-consistency — all predecessors must share the `scope:` tag (compress.rs:179-192).
  const scope = scopeOf(preds[0]!);
  if (preds.some((m) => scopeOf(m) !== scope)) throw new CompressionScopeMismatchError(unique);

  // LLM summarize via RAW TEXT, then parse + the ported guards.
  const raw = await deps.summarize(fillTemplate(preds));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CompressionParseError(raw.slice(0, 200));
  }
  const draft = discriminateCompressOutput(parsed);
  validateCompressedInvariants(draft, unique);

  // Mint Mc: derived_from = the window, consumed_by_user_lessons = saturating sum (compress.rs:217-225).
  // libSQL memory is content-only → fold description into content (matches migrate_memories' shape).
  const consumed = preds.reduce((acc, m) => Math.min(acc + m.consumedByUserLessons, U32_MAX), 0);
  const mc: MemoryRow = {
    id: mintCompressedId(deps.now(), unique),
    content: `${draft.description}\n\n${draft.content}`,
    tags: scope !== null ? [scope] : [],
    source: 'memory',
    author: 'agent',
    createdAt: deps.now().toISOString(),
    derivedFrom: unique,
    consumedByUserLessons: consumed,
  };
  const embedding = await deps.embed(mc.content);
  await deps.insertMemory({ ...mc, embedding }); // ADD only — predecessors untouched
  return mc;
}
