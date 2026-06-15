/**
 * T-AUTO-HANDOFF — the SessionStart reader + tier-3 LAZY GENERATOR.
 *
 * At SessionStart the FU.3 project-scoped pointer still names the DEAD
 * session (it is advanced ONLY by the UserPromptSubmit hook —
 * user-prompt-submit.ts is the sole `recordCurrentSession` caller), so this
 * function can recover even a kill-9'd session: if the dead session's
 * handover doc is absent or older than its FSM state file, GENERATE it from
 * disk first, then inject the pointer. One injection per fresh session
 * (stamped). Fail-quiet: any error → null (never blocks session start).
 *
 * Imports from: zod, ../runtime/handoff/index.js, ../runtime/hooks/session_id.js,
 *   ../runtime/paths.js, ../runtime/result.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring); called by the
 *   default-discipline session-connection-check rule.
 */

import { stat, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { handoverDocPath, renderInjection, runHandoff } from '../runtime/handoff/index.js';
import { hasResumableState } from '../runtime/handoff/substance.js';
import { isSessionPlausible } from '../runtime/hooks/session_liveness.js';
import { readSessionPointer } from '../runtime/hooks/session_id.js';
import { resolveProjectMarker, sessionStateFile } from '../runtime/paths.js';
import { ok } from '../runtime/result.js';

import type { FunctionDef } from './registry.js';

const NoArgs = z.object({}).strict();

interface InjectResult {
  kind: 'inject_context';
  content: string;
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

export const HandoffSessionStart: FunctionDef<z.input<typeof NoArgs>, InjectResult | null> = {
  name: 'handoff_session_start',
  argSchema: NoArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 50,
  execute: async (_args, ctx) => {
    try {
      const cwd =
        ctx.event.kind === 'session_start' ? (ctx.event.cwd ?? process.cwd()) : process.cwd();
      // wg-16803ed82901: the one canonical pointer read (CLAUDE_PROJECT_DIR ?? cwd).
      const deadSid = await readSessionPointer(cwd, process.env);
      if (deadSid === null || deadSid === ctx.sessionId) return ok(null);

      // Once per fresh session.
      const stamp = sessionStateFile(ctx.sessionId, 'handoff-read');
      if ((await mtimeOf(stamp)) !== null) return ok(null);

      const root = (await resolveProjectMarker(cwd))?.root ?? cwd;
      const fsmPath = sessionStateFile(deadSid, 'fsm-coding-flow');
      const fsmM = await mtimeOf(fsmPath);
      // AHO.4: the shared substance predicate (an FSM at bare scoping with no
      // task/artifact is the junk class — same gate as the SessionEnd writer).
      let docPath: string | null = null;
      if (await hasResumableState(deadSid)) {
        // AHO.3: sid-only key — the probe now finds the doc regardless of
        // which day it was generated (the date-keyed path missed yesterday's).
        docPath = handoverDocPath(root, deadSid);
        const docM = await mtimeOf(docPath);
        const docCurrent = docM !== null && fsmM !== null && docM >= fsmM;
        if (!docCurrent) {
          // SUB.3 refined by FXK.2 (0.5.403): liveness gates GENERATION
          // ONLY — injecting a CURRENT doc clobbers nothing (the observed
          // MEMORY.md overwrites were regeneration writes), so graceful-
          // death quick restarts inject instantly. A plausibly-LIVE "dead"
          // sid (nested child, second terminal) skips WITHOUT writing the
          // handoff-read stamp, so a later session retries once the window
          // lapses. freshMs = 10min: the longest a LIVE session goes quiet
          // on its probed files is the 340s audit wait (wg-bc291cb0cef4's
          // inner-window sizing) + margin — 5min would re-open the clobber,
          // 30min over-suppressed kill-9 resumes (the shipped SUB.3 flaw).
          const liveness = await isSessionPlausible(deadSid, { freshMs: 10 * 60_000 });
          if (liveness.plausible) return ok(null);
          const result = await runHandoff(deadSid, cwd); // generate from disk
          docPath = result.docPath;
        }
      }

      await mkdir(dirname(stamp), { recursive: true });
      await writeFile(stamp, new Date().toISOString(), 'utf8');
      if (docPath === null) return ok(null);
      return ok({ kind: 'inject_context', content: renderInjection(docPath) });
    } catch {
      return ok(null); // fail-quiet — never block session start
    }
  },
};
