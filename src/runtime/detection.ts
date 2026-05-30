/**
 * Pure-function evaluator for pack `detected_by:[]` clauses (IDF.2).
 *
 * Given a pack's detected_by array + a pre-staged DetectionContext (cwd
 * file/dir maps, JSON contents, memory hits, recent prompts), returns
 * true iff ANY clause matches (OR semantics — first match wins). An
 * empty array → true (back-compat: a pack with no detected_by always
 * applies among opted-in packs).
 *
 * No I/O during evaluation. The caller (IDF.3 discovery pipeline)
 * pre-stages everything in `ctx`. Keeping the evaluator referentially
 * transparent + cheap to call per dispatch + memoizable across
 * same-context dispatches.
 *
 * Per [[feedback_stop_haiku_drift]] L4: no LLM in detection — pure
 * filesystem + memory + prompt-substring regex.
 *
 * Imported by: src/packs/discovery.ts (IDF.3 auto-activation pipeline);
 * tests.
 */
import { minimatch } from 'minimatch';

import type { DetectedByCheck } from '../packs/schemas/manifest.js';

export interface DetectionContext {
  /** Current working directory (absolute path). Informational; not used by current kinds. */
  cwd: string;
  /** File-existence map pre-staged from `cwd`. Key = relative path; value = true if present. */
  files: Record<string, boolean>;
  /** Directory-existence map pre-staged from `cwd`. */
  dirs: Record<string, boolean>;
  /**
   * File contents pre-staged from `cwd`. Key = relative path; value = file body.
   * Empty / unread files map to ''. JSON files get parsed by the file_match
   * evaluator on demand (no caching at the evaluator layer — caller may LRU
   * around matchesDetectedBy itself per IDF.3 follow-up).
   */
  fileContents: Record<string, string>;
  /**
   * Recent memory hits (body content) — caller queries engine recall + concatenates
   * before staging. memory_match runs regex against this single string.
   */
  memoryBodies: string;
  /** Recent prompt history (concatenated). conversation_signal runs against this. */
  recentPrompts: string;
  /** User explicitly pinned this pack (e.g. via active.json with pin: true). */
  userPinned: boolean;
}

/**
 * Walks `detectedBy[]` and returns true iff ANY clause matches. Empty array
 * → true (back-compat: a pack with no detected_by is always-on among
 * opted-in packs).
 */
export function matchesDetectedBy(
  detectedBy: readonly DetectedByCheck[],
  ctx: DetectionContext,
): boolean {
  if (detectedBy.length === 0) return true;
  for (const check of detectedBy) {
    if (evaluateCheck(check, ctx)) return true;
  }
  return false;
}

function evaluateCheck(check: DetectedByCheck, ctx: DetectionContext): boolean {
  switch (check.kind) {
    case 'file_exists':
      return ctx.files[check.path] === true;
    case 'dir_exists':
      return ctx.dirs[check.path] === true;
    case 'file_match':
      return evaluateFileMatch(check.path, check.matches, ctx);
    case 'file_glob':
      return evaluateFileGlob(check.pattern, check.min_count, ctx);
    case 'memory_match':
      return safeRegexTest(check.pattern, ctx.memoryBodies);
    case 'conversation_signal':
      return safeRegexTest(check.pattern, ctx.recentPrompts);
    case 'user_pinned':
      return ctx.userPinned;
  }
}

function evaluateFileMatch(
  path: string,
  matches: Record<string, string>,
  ctx: DetectionContext,
): boolean {
  const content = ctx.fileContents[path];
  if (content === undefined || content === '') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  for (const [jsonPath, pattern] of Object.entries(matches)) {
    const value = resolveJsonPath(parsed, jsonPath);
    if (typeof value !== 'string') return false;
    if (!safeRegexTest(pattern, value)) return false;
  }
  return true;
}

function evaluateFileGlob(pattern: string, minCount: number, ctx: DetectionContext): boolean {
  let count = 0;
  for (const path of Object.keys(ctx.files)) {
    if (!ctx.files[path]) continue;
    if (minimatch(path, pattern)) {
      count++;
      if (count >= minCount) return true;
    }
  }
  return false;
}

/** Dotted JSON path lookup: `dependencies.react` → obj.dependencies.react. Shallow only — no `[index]`, no quoted-segments. */
function resolveJsonPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * RE2-safe regex test. Per [[feedback_stop_haiku_drift]] L8 + the H grammar
 * lock: the project uses re2js / re2-wasm for user-authored regex; here we
 * use JS RegExp on patterns that come from manifest.yaml. ReDoS surface is
 * documented; pack-load-time RE2 validation is a deferred follow-up (not
 * blocking IDF.2). For now, malformed patterns silently fail the clause
 * rather than throw — loud failure deferred to pack-load validation.
 */
function safeRegexTest(pattern: string, target: string): boolean {
  try {
    return new RegExp(pattern).test(target);
  } catch {
    return false;
  }
}
