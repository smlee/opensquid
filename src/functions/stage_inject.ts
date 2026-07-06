/**
 * `stage_inject` — the v2 per-stage instruction injector (the generic-cartridge injection form).
 *
 * BEFORE the agent acts in a stage, deliver THAT stage's operating procedure (+ its audit rubric) into context
 * so the agent follows the stage's gate-satisfying flow rather than tripping the gate. Fires on the events that
 * precede an action:
 *   - `prompt_submit` / `session_start` — orient at turn start, before the first tool (survives compaction).
 *   - `tool_call` (PreToolUse) — the mid-turn catch: a tool call that crossed a stage boundary re-orients to the
 *     NEW stage before the next action; deduped so a same-stage call injects nothing (cheap on the hot path).
 *
 * NEED-TO-KNOW: reads ONLY the CURRENT stage's procedure + rubric on demand (read_procedure / read_rubric,
 * resolved by the active pack via `ctx.packId`) — never the whole procedure. A stage with no procedure file
 * (a terminal/decision FSM state) injects nothing. PACK-AGNOSTIC: the stage IS the active pack's FSM state
 * (`readFsmStateRaw(sid, ctx.packId)`), so this serves whichever v2 cartridge is active.
 */
import { z } from 'zod';

import { atomicWriteFile } from '../runtime/atomic_write.js';
import { readFsmStateFile } from '../runtime/fsm_state.js';
import { sessionStateFile } from '../runtime/paths.js';
import { ok } from '../runtime/result.js';

import { buildInjectContext } from './inject_context.js';
import { readProcedureContent } from './read_procedure.js';
import type { FunctionRegistry } from './registry.js';
import { buildStageBundle } from './stage_context.js';

/** Per-(session,pack) dedup key: the stage last injected this session (channel b reads it to skip a re-inject). */
const stageKey = (packId: string): string => `last-injected-stage-${packId}`;

/** Read the stage last injected this session for `packId`, or null if none yet. */
async function readLastStage(sessionId: string, packId: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const parsed = JSON.parse(
      await readFile(sessionStateFile(sessionId, stageKey(packId)), 'utf8'),
    ) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'stage' in parsed) {
      const s: unknown = parsed.stage;
      if (typeof s === 'string') return s;
    }
  } catch {
    /* absent / parse error → null */
  }
  return null;
}

const EmptyArgs = z.object({}).strict();

export function registerStageInject(registry: FunctionRegistry): void {
  registry.register({
    name: 'stage_inject',
    argSchema: EmptyArgs,
    durable: false,
    memoizable: false, // re-evaluate each turn so the injection refreshes + reflects a stage change
    costEstimateMs: 3,
    execute: async (_args, ctx) => {
      const kind = ctx.event.kind;
      if (kind !== 'prompt_submit' && kind !== 'session_start' && kind !== 'tool_call') {
        return ok(null);
      }
      // The CURRENT stage = the active pack's FSM state (the file also carries history for the checkpoint).
      const fsm = await readFsmStateFile(ctx.sessionId, ctx.packId);
      if (fsm === null) return ok(null);
      const stage = fsm.state;
      // A terminal/decision state has no procedure → nothing to inject (cheap pre-check before the dedup read).
      if ((await readProcedureContent(stage, ctx.packId)) === null) return ok(null);
      // Channel (b) dedup — same stage as the last inject on a tool_call → stay silent (avoids re-injecting
      // the same stage mid-turn). Channel (a) always refreshes.
      if (kind === 'tool_call' && stage === (await readLastStage(ctx.sessionId, ctx.packId))) {
        return ok(null);
      }
      // The standardized 4-slot bundle [CHECKPOINT, PROCEDURE, RUBRIC, WORK-CONTEXT] — the SAME builder the
      // per-stage loop (PSL.3) uses, so the hook path and the loop path inject identical context.
      const text = await buildStageBundle(ctx.sessionId, ctx.packId, fsm);
      if (text.length === 0) return ok(null);
      await atomicWriteFile(
        sessionStateFile(ctx.sessionId, stageKey(ctx.packId)),
        JSON.stringify({ stage }),
      );
      return ok(buildInjectContext(text));
    },
  });
}
