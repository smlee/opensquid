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

import {
  handoverDocPath,
  renderInjection,
  runHandoff,
  umbrellaRootFor,
} from '../runtime/handoff/index.js';
import { hasResumableState } from '../runtime/handoff/substance.js';
import { readProjectCurrentSession } from '../runtime/hooks/session_id.js';
import { resolveProjectUuid, sessionStateFile } from '../runtime/paths.js';
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
      const uuid = await resolveProjectUuid({ cwd, env: process.env });
      if (uuid === null) return ok(null);
      const deadSid = await readProjectCurrentSession(uuid);
      if (deadSid === null || deadSid === ctx.sessionId) return ok(null);

      // Once per fresh session.
      const stamp = sessionStateFile(ctx.sessionId, 'handoff-read');
      if ((await mtimeOf(stamp)) !== null) return ok(null);

      const umbrellaRoot = await umbrellaRootFor(cwd);
      const fsmPath = sessionStateFile(deadSid, 'fsm-coding-flow');
      const fsmM = await mtimeOf(fsmPath);
      // AHO.4: the shared substance predicate (an FSM at bare scoping with no
      // task/artifact is the junk class — same gate as the SessionEnd writer).
      let docPath: string | null = null;
      if (await hasResumableState(deadSid)) {
        // AHO.3: sid-only key — the probe now finds the doc regardless of
        // which day it was generated (the date-keyed path missed yesterday's).
        docPath = handoverDocPath(umbrellaRoot, deadSid);
        const docM = await mtimeOf(docPath);
        if (docM === null || fsmM === null || docM < fsmM) {
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
