/**
 * FAC-CUT.5b.2 — the IN-PROCESS v2 host supply (T-fac-cut-5b2-v2-host-supply).
 *
 * Makes a v2 cartridge actually RUN inside the live hook path (the FAC-CUT.4 seam: in-process, NOT the daemon
 * bus — there is no `Bus` in a hook subprocess, `host.ts:131`). On each hook event: load the active v2
 * cartridges, seed each pure `V2ObservedActor` from its persisted `fsm-<pack>` state, `receive` the event,
 * and APPLY the returned effects — `write_state` → persist; `transition` → `appendTransition` (INV2
 * observability, the v1 durable equivalent of the bus transition, `transition_log.ts:10-11`); `gate_action` →
 * the hook decision (block/halt → exit 2; warn → a nudge). The whole per-cartridge step is FAIL-OPEN: a v2
 * cartridge bug NEVER breaks the hook.
 *
 * ADDITIVE + inert: when no ACTIVE v2 cartridge exists (true today — zero `pack.yaml`, active packs all v1),
 * `runV2Cartridges` returns the ZERO decision, so the merged hook result is byte-identical to v1.
 *
 * Imports from: ../bootstrap (loadActiveV2Cartridges), ./v2_observed_actor, ../fsm_state, ../observe/transition_log.
 * Imported by: src/runtime/hooks/pre-tool-use.ts + post-tool-use.ts (merged after dispatchEvent).
 */
import { readFile } from 'node:fs/promises';

import { loadActiveV2Cartridges } from '../bootstrap.js';
import { persistActorState, readFsmState } from '../fsm_state.js';
import { appendTransition } from '../observe/transition_log.js';
import { sessionStateFile } from '../paths.js';
import { InMemorySkillRuntime, onStateEntry, onStateLeave } from '../skill/state_skills.js';
import { V2ObservedActor } from './v2_observed_actor.js';

import type { Envelope } from '../bus/types.js';
import type { Event } from '../event.js';

export interface V2Decision {
  exitCode: 0 | 2;
  /** block/halt instructions → stderr (the in-process observation of enforcement). */
  messages: string[];
  /** warn nudges → additionalContext. */
  injections: string[];
  /**
   * SKILL.1 (R-SKILLS-PER-STATE) — the skills bound for the cartridge's CURRENT state this event (state IS the
   * router). A DEDICATED channel, distinct from `injections` (warn nudges). Delivering this set's CONTENT into
   * the agent context is the Track-2 skill-loader host; this field is the binding's observable.
   */
  boundSkills: string[];
}

const ZERO: V2Decision = { exitCode: 0, messages: [], injections: [], boundSkills: [] };

/** FAIL-OPEN read of a coding-flow audit-cache verdict (mirrors handoff/collect.ts readJsonState+auditHead):
 *  the flat `{ verdict: string }` shape; ANY error → undefined (observe-never-breaks). */
async function readVerdict(sessionId: string, key: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sessionStateFile(sessionId, key), 'utf8')) as {
      verdict?: unknown;
    };
    return typeof parsed.verdict === 'string' ? parsed.verdict : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Guard ctx for a v2 cartridge event (R-AUDIT-CTX) — binds the THREE pieces a discipline guard reads: the
 * `event`/`tool`, the guess/spec audit verdicts (FAIL-OPEN), and the `phase` (the cartridge's current FSM
 * state). Literal `.set` keys so the coverage binding-extractor sees them (coverage/index_build.ts).
 */
export async function buildGuardCtx(
  event: Event,
  sessionId: string,
  phase: string,
): Promise<Map<string, unknown>> {
  const m = new Map<string, unknown>();
  m.set('event', event.kind);
  if ('tool' in event) m.set('tool', event.tool);
  m.set('verdict.guess', await readVerdict(sessionId, 'coding-flow-guess-audit-cache'));
  m.set('verdict.spec', await readVerdict(sessionId, 'coding-flow-spec-audit-cache'));
  m.set('phase', phase);
  return m;
}

/**
 * Run every ACTIVE v2 cartridge over `event` and return the merged decision (most-severe exit wins). ADDITIVE:
 * returns ZERO when there are no active v2 cartridges, so a caller merging this into the v1 decision is a no-op.
 */
export async function runV2Cartridges(
  sessionId: string,
  event: Event,
  now: string,
): Promise<V2Decision> {
  const cartridges = await loadActiveV2Cartridges(sessionId);
  if (cartridges.length === 0) return ZERO; // INERT — the nothing-breaks path (no active v2 pack today)
  let exitCode: 0 | 2 = 0;
  const messages: string[] = [];
  const injections: string[] = [];
  const boundSkills: string[] = [];
  for (const loaded of cartridges) {
    try {
      if (loaded.compiled.fsm === undefined) continue; // foundation cartridge → not an observed actor
      const name = loaded.pack.name;
      const actor = new V2ObservedActor(`pack:${name}`, loaded);
      actor.state.current = await readFsmState(sessionId, name, actor.fsm);
      const env: Envelope = {
        seq: 0,
        from: `pack:${name}`,
        to: `pack:${name}`,
        kind: event.kind,
        // R-AUDIT-CTX: phase = the cartridge's current FSM state (pre-receive); verdicts read fail-open.
        payload: { ctx: await buildGuardCtx(event, sessionId, actor.state.current) },
        ts: Date.parse(now),
      };
      // SKILL.1 (R-SKILLS-PER-STATE): one runtime per cartridge; `onStateLeave` on each transition, then bind
      // the CURRENT (post-receive) state on EVERY event — the state IS the router (not only on transitions).
      const skillRuntime = new InMemorySkillRuntime();
      for (const e of await actor.receive(env)) {
        if (e.kind === 'write_state') {
          await persistActorState(sessionId, name, e.state, now);
        } else if (e.kind === 'emit' && e.messageKind === 'transition') {
          // INV2 in-process observability — the cited v1 durable equivalent of the bus transition.
          const p = e.payload as { from: string; to: string };
          await appendTransition({
            session: sessionId,
            pack: name,
            from: p.from,
            to: p.to,
            on: event.kind,
            at: now,
            via: -1,
          });
          onStateLeave(p.from, skillRuntime); // SKILL.1: unloaded on leave
        } else if (e.kind === 'emit' && e.messageKind === 'gate_action') {
          const p = e.payload as { action: 'warn' | 'block' | 'halt'; message: string };
          if (p.action === 'warn') injections.push(p.message);
          else {
            exitCode = 2; // block | halt → ENFORCE (gate/kernel.ts:37-38); the deny IS the observation
            messages.push(p.message);
          }
        }
      }
      // actor.state.current is the final (post-event) state (v2_observed_actor.ts:97) → bind skills(S) every event.
      onStateEntry(actor.state.current, loaded.compiled.meta, skillRuntime);
      boundSkills.push(...skillRuntime.current().skills);
    } catch (err) {
      // FAIL-OPEN: a v2 cartridge bug must NEVER break the hook (observe-never-breaks discipline).
      process.stderr.write(`[v2-supply] cartridge error (ignored): ${String(err)}\n`);
    }
  }
  return { exitCode, messages, injections, boundSkills };
}
