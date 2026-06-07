/**
 * effective_content (T-FLOW-AUDIT-ARTIFACT) — the artifact content that WILL
 * exist AFTER the pending Write/Edit/MultiEdit, so a content audit reviews the
 * REAL resulting file regardless of tool shape.
 *
 * The flaw it fixes: the SCOPE/AUTHOR content audits read `{{targs.content}}`,
 * which is populated ONLY for the Write tool. The Edit tool carries
 * `old_string`/`new_string` (no `content`), so refining a doc via Edit — the
 * normal authoring loop — fed the audit an EMPTY string. The audit then never
 * returns GUESS_FREE/SPEC_COMPLETE and the FSM never advances; the flow becomes
 * un-completable through iterative editing (verified 2026-06-06).
 *
 * Resolution: compute the post-change content here. Write → `content` verbatim.
 * Edit → read the current file and apply `old_string`→`new_string`. MultiEdit →
 * apply each edit in order. Any other tool / non-tool_call event → ''.
 *
 * PreToolUse timing: the hook fires BEFORE the write lands, so the on-disk file
 * is the PRE-change version — exactly what we need to apply the pending edit to.
 *
 * Fail-soft: an unreadable file or malformed args → '' (the audit then sees
 * empty and fails CLOSED — no false pass). Never throws.
 *
 * Imports from: node:fs/promises, zod, ../runtime/result.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { ok } from '../runtime/result.js';

import type { FunctionDef } from './registry.js';

const EmptyArgs = z.object({}).strict();

function applyReplace(haystack: string, oldS: string, newS: string): string {
  // Audit-grade reconstruction: replace ALL occurrences (split/join). The audit
  // only needs to read the resulting prose, so first-vs-all is immaterial here.
  return oldS === '' ? haystack : haystack.split(oldS).join(newS);
}

export const EffectiveContent: FunctionDef<z.input<typeof EmptyArgs>, string> = {
  name: 'effective_content',
  argSchema: EmptyArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 2,
  execute: async (_args, ctx) => {
    if (ctx.event.kind !== 'tool_call') return ok('');
    const tool = ctx.event.tool;
    const a = (ctx.event.args ?? {}) as Record<string, unknown>;
    try {
      if (tool === 'Write') return ok(typeof a.content === 'string' ? a.content : '');
      const filePath = typeof a.file_path === 'string' ? a.file_path : '';
      if (filePath === '') return ok('');
      const current = await readFile(filePath, 'utf8').catch(() => '');
      if (tool === 'Edit') {
        const oldS = typeof a.old_string === 'string' ? a.old_string : '';
        const newS = typeof a.new_string === 'string' ? a.new_string : '';
        return ok(applyReplace(current, oldS, newS));
      }
      if (tool === 'MultiEdit' && Array.isArray(a.edits)) {
        let content = current;
        for (const e of a.edits as Array<Record<string, unknown>>) {
          const oldS = typeof e.old_string === 'string' ? e.old_string : '';
          const newS = typeof e.new_string === 'string' ? e.new_string : '';
          content = applyReplace(content, oldS, newS);
        }
        return ok(content);
      }
      return ok('');
    } catch {
      return ok('');
    }
  },
};
