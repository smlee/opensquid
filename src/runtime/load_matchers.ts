/**
 * `when_to_load` matcher evaluator.
 *
 * Skills declare load conditions as a list of matchers. The runtime walks the
 * list per Event and asks: "does this skill want to activate now?" Matchers
 * are pure predicates (no I/O, no side effects) so the evaluator can run on
 * every PreToolUse / UserPromptSubmit / Stop / SessionEnd hook without
 * starving the agent budget.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Skill format" +
 * §"Skill properties" + spec `docs/tasks/phase-3-dynamic-loading.md` task 3.1.
 *
 * Four matcher kinds (discriminated on `kind`):
 *
 *   tool_match       — exact tool name match on a `tool_call` event.
 *   command_pattern  — regex against `tool_call.args.command` (Bash flavor).
 *   file_glob        — minimatch glob against a file-path field on `tool_call`.
 *   event_type       — match the event's own `kind` literal.
 *
 * Semantics are OR: a non-empty matcher list activates the skill if ANY
 * matcher hits. An empty list never activates (a skill with empty
 * `when_to_load` is either `load: preload` or intentionally inert).
 *
 * Shorthand surface — pack authors write the common case as a single-key
 * object:
 *
 *   when_to_load:
 *     - tool_match: Bash             # canonical: { kind: tool_match, tool: Bash }
 *     - command_pattern: '^git'      # canonical: { kind: command_pattern, pattern: '^git' }
 *     - file_glob: 'src/**\/*.ts'    # canonical: { kind: file_glob, glob: 'src/**\/*.ts' }
 *     - event_type: prompt_submit    # canonical: { kind: event_type, type: prompt_submit }
 *
 * `normalizeMatcher` accepts either form. `Matcher` (the Zod schema) only
 * accepts the canonical (discriminated) form so that everything past the YAML
 * boundary is type-safe.
 *
 * File-glob field precedence on `tool_call` events: `file_path` → `path` →
 * `notebook_path`. Multiple host conventions, picked in this order because
 * Claude Code's Read/Edit/Write surface `file_path`, generic FS tools surface
 * `path`, and notebook editors surface `notebook_path`. The first non-empty
 * string wins.
 *
 * Imports from: zod, minimatch, ./types.
 * Imported by: src/packs/schemas/skill.ts, src/runtime/index.ts.
 */

import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { Event } from './types.js';

// ---------------------------------------------------------------------------
// Matcher — canonical discriminated form. The shorthand pre-pass converts
// single-key objects (`{tool_match: 'Bash'}`) to this shape before parsing.
// ---------------------------------------------------------------------------

const EventTypeLiteral = z.enum(['tool_call', 'prompt_submit', 'stop', 'session_end']);

export const MatcherCanonical = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool_match'), tool: z.string().min(1) }),
  z.object({ kind: z.literal('command_pattern'), pattern: z.string().min(1) }),
  z.object({ kind: z.literal('file_glob'), glob: z.string().min(1) }),
  z.object({ kind: z.literal('event_type'), type: EventTypeLiteral }),
]);
export type Matcher = z.infer<typeof MatcherCanonical>;

// ---------------------------------------------------------------------------
// Shorthand normalizer — collapses `{tool_match: 'Bash'}` to canonical form.
//
// We accept these exact single-key shapes (one key, value is a non-empty
// string, key name matches a Matcher kind). Anything else passes through
// unchanged so Zod can produce a precise error path. We deliberately do NOT
// guess on multi-key objects (e.g. `{kind: 'tool_match', tool: 'Bash', x: 1}`)
// — extra keys would silently be dropped by the discriminated union, so the
// canonical form already self-validates.
// ---------------------------------------------------------------------------

const SHORTHAND_KEYS = ['tool_match', 'command_pattern', 'file_glob', 'event_type'] as const;
type ShorthandKey = (typeof SHORTHAND_KEYS)[number];

function isShorthandKey(k: string): k is ShorthandKey {
  return (SHORTHAND_KEYS as readonly string[]).includes(k);
}

export function normalizeMatcher(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return raw;
  const k = keys[0];
  if (k === undefined || !isShorthandKey(k)) return raw;
  const v = obj[k];
  if (typeof v !== 'string') return raw;
  switch (k) {
    case 'tool_match':
      return { kind: 'tool_match', tool: v };
    case 'command_pattern':
      return { kind: 'command_pattern', pattern: v };
    case 'file_glob':
      return { kind: 'file_glob', glob: v };
    case 'event_type':
      return { kind: 'event_type', type: v };
  }
}

// ---------------------------------------------------------------------------
// Matcher — public schema used by `Skill.when_to_load`. Wraps the canonical
// discriminated union with a `z.preprocess` that runs the shorthand pass.
// ---------------------------------------------------------------------------

export const Matcher = z.preprocess(normalizeMatcher, MatcherCanonical);

// ---------------------------------------------------------------------------
// Regex cache — `command_pattern` patterns recompile on every event without
// this. Cache key is the pattern string itself; entries never expire (matchers
// come from pack YAML, so the working set is bounded by pack count).
//
// `compileRegex` returns `null` on bad regex AND logs to stderr. The matcher
// then treats that pattern as a non-match so a typoed regex degrades a single
// skill, not the whole hook. Negative results are NOT cached — fixing a typo
// at pack-edit time should take effect on next load.
// ---------------------------------------------------------------------------

const regexCache = new Map<string, RegExp>();

function compileRegex(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  try {
    const r = new RegExp(pattern);
    regexCache.set(pattern, r);
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[opensquid] when_to_load command_pattern bad regex: ${pattern} — ${msg}`);
    return null;
  }
}

/** Test-only: drop the regex cache so per-test mutations don't leak. */
export function clearRegexCache(): void {
  regexCache.clear();
}

// ---------------------------------------------------------------------------
// Field precedence for `file_glob` — Claude Code's Read/Edit/Write use
// `file_path`, generic FS tools use `path`, NotebookEdit uses `notebook_path`.
// First non-empty wins. Returns empty string when none present so callers can
// short-circuit cheaply.
// ---------------------------------------------------------------------------

function extractFilePath(args: Readonly<Record<string, unknown>>): string {
  const candidates: readonly string[] = ['file_path', 'path', 'notebook_path'];
  for (const key of candidates) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

// ---------------------------------------------------------------------------
// matchesEvent — OR-walk the matcher list. Returns true on first hit.
//
// Tool-call-only matchers (`tool_match`, `command_pattern`, `file_glob`)
// short-circuit when the event isn't a tool_call. `event_type` works on every
// kind. The function is pure — no state, no I/O, no throws.
// ---------------------------------------------------------------------------

export function matchesEvent(matchers: readonly Matcher[], event: Event): boolean {
  for (const m of matchers) {
    if (m.kind === 'event_type') {
      if (m.type === event.kind) return true;
      continue;
    }
    if (event.kind !== 'tool_call') continue;
    if (m.kind === 'tool_match') {
      if (event.tool === m.tool) return true;
      continue;
    }
    if (m.kind === 'command_pattern') {
      const cmd = event.args.command;
      if (typeof cmd !== 'string') continue;
      const re = compileRegex(m.pattern);
      if (re?.test(cmd) === true) return true;
      continue;
    }
    if (m.kind === 'file_glob') {
      const path = extractFilePath(event.args);
      if (path !== '' && minimatch(path, m.glob)) return true;
      continue;
    }
  }
  return false;
}
