/**
 * Lesson primitives: `propose_lesson`, `promote_lesson`, `recall_lesson`.
 *
 * T-loop-engine-reintegration T.6 — surfaces the loop-engine wedge gate
 * to skills. Three atomic primitives compose into capture/promote/recall
 * workflows; the gate itself lives in `engine/src/engine/lessons/gate.rs`.
 *
 * Why these three (and only these three):
 *   - `propose_lesson` — the capture surface. Skill authors call this
 *     when an agent or user proposes a new lesson candidate. Agent-
 *     authored lessons remain `pending` until the gate promotes them;
 *     user-authored lessons skip the gate (eviction-immune via
 *     `Authorship::is_immune` per T.1.G).
 *   - `promote_lesson` — the gate firing surface. Calls engine's
 *     `lesson.promote`, which runs the wedge checks. A block here is
 *     the entire competitive moat (per
 *     `project_2026_05_12_strategic_pivot`): the only system that
 *     refuses to self-grade promotions. We surface the block as a
 *     successful `ok({status:'blocked', reasons})` because the block IS
 *     the system working as designed — not a runtime error.
 *   - `recall_lesson` — text-match retrieval across pending/active/
 *     promoted/superseded status dirs (T.1.B). NOT vector — that
 *     property surfaces evidence-less lessons during the capture loop
 *     even when the embedder is degraded.
 *
 * What's intentionally NOT here (out of scope; pack-install only):
 *   - `pack_id`, `external_id`, `seed_as_promoted` on propose_lesson —
 *     pack-authored seed paths handled by a separate install flow
 *     (T.1.B notes the validation rules: `pack_id` required when
 *     `authored_by === 'pack'`, `seed_as_promoted` requires
 *     `authored_by === 'pack'`).
 *
 * Authored_by encoding gotcha (T.1.G):
 *   The wire input only honors `'user'` and `'pack'`. Anything else —
 *   including `'agent'` from a Zod-validated arg — silently maps to
 *   engine's `Llm` default. We accept `'user' | 'agent'` from skill
 *   authors for ergonomic symmetry with the existing `store_lesson`
 *   primitive, then translate: `'user'` passes through verbatim;
 *   `'agent'` becomes `undefined` (engine default Llm). User-authored
 *   lessons are eviction-immune; agent/llm-authored aren't.
 *
 * Why no "permits promotion" test (deliberate scope correction per
 * T.1.F + T.1.HH + spec line 967-969):
 *   The engine's `PromotionConfig::default()` requires:
 *     min_age = 24 hours
 *     min_applied_count = 3 (via manifest.assemble side effect)
 *     external_signal_sources non-empty (via lesson.capture_feedback)
 *     causal_narrative present (auto-built when evidence is supplied)
 *   None of those are satisfiable in unit-test timescales — that's the
 *   moat working as designed, not a bug. T.6 proves the gate FIRES
 *   (block-only E2E); production promotion only happens over real
 *   session usage. T.8 will file an engine follow-up to expose a
 *   PromotionConfig override for testing, but that's NOT in T.6 scope.
 *
 * Imports from: zod, ../engine/client.js, ../engine/types.js,
 *   ../runtime/result.js, ./registry.js.
 * Imported by: ../runtime/bootstrap.ts.
 */

import { z } from 'zod';

import { err, ok } from '../runtime/result.js';
import { PromotionBlockedError, type WedgeLessonStore } from '../rag/wedge/store.js';

import type { FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Zod arg schemas.
//
// `description` / `body` get `min(1)` to block empty-string foot-guns. The
// engine would reject empty strings too, but the Zod check surfaces the
// problem at the function-call boundary (cleaner error path than a JSON-RPC
// round-trip).
//
// `authored_by` accepts the human-friendly `'user' | 'agent'` enum. The
// 'agent' value is translated to engine's wire-level default (Llm) inside
// execute(); see the file header for the rationale.
//
// `recall_lesson.limit` is bounded to [1, 50] — engine doesn't enforce an
// upper bound itself, but a 1000-row dump from a YAML wiring bug is more
// likely than a real need for >50 lesson hits.
// ---------------------------------------------------------------------------

const ProposeLessonArgs = z.object({
  description: z.string().min(1),
  body: z.string().min(1),
  evidence: z.array(z.string()).optional(),
  authored_by: z.enum(['user', 'agent']).optional(),
  // pack_id / external_id / seed_as_promoted intentionally NOT exposed here.
  // Those are pack-install-only paths handled separately (see header).
});

const PromoteLessonArgs = z.object({
  id: z.string().min(1),
});

const RecallLessonArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});

export function registerLessonFunctions(registry: FunctionRegistry, store: WedgeLessonStore): void {
  // DURABLE.2 — all three primitives touch the loop-engine UDS. `propose` and
  // `promote` are durable side-effecting writes (re-running on resume creates
  // a duplicate lesson or re-fires the gate). They are NOT memoizable —
  // memoizing a write would silently no-op the second insert. `recall` is
  // durable + memoizable (text-match output is deterministic for the same
  // query within a bounded TTL — the in-memory memo cache picks up the
  // repeat). All flags declared explicitly so the registry's `durable`
  // omission warning stays quiet.
  registry.register({
    name: 'propose_lesson',
    argSchema: ProposeLessonArgs,
    durable: true,
    memoizable: false,
    costEstimateMs: 30,
    execute: async (args) => {
      try {
        // Only 'user' propagates (user-authored lessons are eviction-immune);
        // 'agent' is the store default. `exactOptionalPropertyTypes` → OMIT.
        const r = await store.createLesson({
          description: args.description,
          body: args.body,
          ...(args.evidence && args.evidence.length > 0 ? { evidenceRefs: args.evidence } : {}),
          ...(args.authored_by === 'user' ? { authoredBy: 'user' as const } : {}),
        });
        return ok({ id: r.id, status: r.status });
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `propose_lesson: ${String(e)}`,
          cause: e,
        });
      }
    },
  });

  /**
   * `promote_lesson` returns two `status` cases — branch deterministically.
   *
   * Usage from a YAML skill:
   *
   * ```yaml
   * process:
   *   - function: promote_lesson
   *     args: { id: "{lesson_id}" }
   *     bind: result
   * verdict: |
   *   if (result.status === "blocked") return { kind: "block", reasons: result.reasons };
   *   return { kind: "promote" };
   * ```
   *
   * `status: 'blocked'` means the wedge gate fired (moat working as
   * designed — NOT an error). `kind: 'runtime'` on the Result envelope
   * means a genuine infra failure (engine unreachable, etc.).
   */
  registry.register<{ id: string }, PromoteLessonResult>({
    name: 'promote_lesson',
    argSchema: PromoteLessonArgs,
    durable: true,
    memoizable: false,
    costEstimateMs: 50,
    execute: async (args) => {
      try {
        const r = await store.promoteLesson(args.id);
        return ok({ status: 'promoted' as const, detail: r });
      } catch (e) {
        // A gate block surfaces as PromotionBlockedError with kebab-prefix
        // reasons. This is the wedge moat firing — NOT a runtime error —
        // so surface it as a successful Result with `status: 'blocked'`
        // (skills branch on the field). (The engine-era compression hook
        // that nominated cited memories on promotion is dropped here; that
        // coupling moves to the compression port, RES-4.)
        if (e instanceof PromotionBlockedError) {
          return ok({ status: 'blocked' as const, reasons: e.reasons });
        }
        return err({
          kind: 'runtime',
          message: `promote_lesson: ${String(e)}`,
          cause: e,
        });
      }
    },
  });

  registry.register({
    name: 'recall_lesson',
    argSchema: RecallLessonArgs,
    durable: true,
    memoizable: true,
    costEstimateMs: 50,
    execute: async (args) => {
      try {
        // Text-match (FTS) across non-discarded statuses. `limit` defaults to
        // 5 in the store when omitted.
        return ok(await store.recallLesson(args.query, args.limit));
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `recall_lesson: ${String(e)}`,
          cause: e,
        });
      }
    },
  });

  // capture_feedback + record_applied — the two in-process surfaces the wedge
  // gate needs to ever PROMOTE: the DEFAULT gate requires a non-empty
  // external_signal_sources (fed by capture_feedback) AND applied_count >= 3
  // (fed by record_applied). The engine fed these via its feedback RPC +
  // manifest.assemble; in-process both must be reachable or promotion is
  // unsatisfiable.
  registry.register({
    name: 'capture_feedback',
    argSchema: z.object({
      id: z.string().min(1),
      polarity: z.enum(['up', 'down']),
      signal_id: z.string().min(1),
    }),
    durable: true,
    memoizable: false,
    costEstimateMs: 20,
    execute: async (args) => {
      try {
        await store.captureFeedback(args.id, args.polarity, args.signal_id);
        return ok({ id: args.id });
      } catch (e) {
        return err({ kind: 'runtime', message: `capture_feedback: ${String(e)}`, cause: e });
      }
    },
  });

  registry.register({
    name: 'record_applied',
    argSchema: z.object({ id: z.string().min(1), session_id: z.string().optional() }),
    durable: true,
    memoizable: false,
    costEstimateMs: 20,
    execute: async (args) => {
      try {
        await store.recordApplied(args.id, args.session_id);
        return ok({ id: args.id });
      } catch (e) {
        return err({ kind: 'runtime', message: `record_applied: ${String(e)}`, cause: e });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Public result-shape types — exported so call sites can narrow on
// `status` without re-deriving the union locally.
// ---------------------------------------------------------------------------

/**
 * Result of a `promote_lesson` call.
 *
 * `'promoted'` means the engine accepted the promotion (the wedge gate ran
 * AND passed — production happy path after 24h+ real session usage).
 *
 * `'blocked'` means the engine ran the gate and refused the promotion.
 * `reasons` carries kebab-case BlockReason::Display strings (T.1.F). This
 * is the moat firing, NOT an error — skills branch on this field to
 * decide whether to surface the block to the user or capture more
 * evidence and retry.
 */
export type PromoteLessonResult =
  | { status: 'promoted'; detail: { id: string; status: 'promoted' } }
  | { status: 'blocked'; reasons: string[] };
