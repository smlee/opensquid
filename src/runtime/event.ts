/**
 * Event union + Trigger schema — split out of `types.ts` per the AUTO.1
 * file-size constraint ("types.ts stays under 400 LOC; split into
 * `types/event.ts` if exceeded").
 *
 * `types.ts` re-exports every symbol declared here so existing
 * `import { Event } from './types.js'` callsites continue to work — this
 * file is internal layout, not a new public surface.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"The architecture
 * in six concepts" (concept 1: Event) + `docs/tasks/automation.md` AUTO.1
 * "Key code shapes" (the four new event variants + `triggers:` block).
 *
 * What lives here:
 *   - The Event variants (tool_call, post_tool_call, prompt_submit,
 *     session_end, stop, session_start, schedule, webhook, inbound_channel,
 *     file_changed) — post_tool_call added by POSTPUSH.1, session_start by
 *     HH6.1
 *   - The `Event` discriminated union
 *   - `EventKind` enum (the matching discriminator literals)
 *   - `Trigger` discriminated union + `DEFAULT_TRIGGERS` + `defaultTriggers()`
 *
 * What does NOT live here:
 *   - Verdict / Rule / Skill / Pack schemas → `types.ts` (the cross-process
 *     contract for the rest of the runtime).
 *   - DriftPolicy / RuntimeAction / PauseState → `types.ts` (drift-response
 *     and pause-state machinery).
 *
 * Naming: `event.ts` (sibling) rather than `types/event.ts` (subdir) to
 * avoid the NodeNext name collision between a sibling file `types.ts` and a
 * sibling directory `types/`. Both `.ts` and `.d.ts` resolvers can find
 * `./event.js` cleanly while preserving every existing `./types.js` import.
 *
 * Imports from: zod.
 * Imported by: src/runtime/types.ts (re-export barrel).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Event — discriminated union on `kind`.
//
// Use `z.discriminatedUnion` (not `z.union`) so TS narrows on `event.kind`
// inside a `switch` and ZodError points at the right variant on rejection.
// ---------------------------------------------------------------------------

export const ToolCallEvent = z.object({
  kind: z.literal('tool_call'),
  tool: z.string(),
  args: z.record(z.unknown()),
  cwd: z.string().optional(),
});
export type ToolCallEvent = z.infer<typeof ToolCallEvent>;

// T-POSTPUSH POSTPUSH.1 (2026-05-29) — PostToolUse event fires AFTER a tool
// call completes. exit_code lets gate skills react to success/failure
// (canonical case = verify-CI-after-push fires only on exit_code === 0).
// stdout/stderr/duration_ms are payload extras Claude Code includes; skills
// don't currently consume them but the schema accepts them for forward
// compat. Active-task mirror is NOT re-fired from this event (PreToolUse
// already handles that surface — double-firing would duplicate writes).
export const PostToolCallEvent = z.object({
  kind: z.literal('post_tool_call'),
  tool: z.string(),
  args: z.record(z.unknown()),
  exit_code: z.number().int(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  cwd: z.string().optional(),
  duration_ms: z.number().optional(),
});
export type PostToolCallEvent = z.infer<typeof PostToolCallEvent>;

// T-RESPONSE-JUDGING-UPS RJ.1 (2026-06-01) — `priorAssistantText` carries the
// SETTLED prior assistant turn so response-judging gates (honesty-ledger,
// phase-logging, d9-guard) can run at UserPromptSubmit instead of Stop. CC
// provides `transcript_path` on UserPromptSubmit and the prior turn is already
// flushed at fire-time (confirmed against CC hook docs), so the UPS hook bin
// fills this via `readLastAssistantText` with NO off-by-one (unlike Stop, where
// the triggering response isn't flushed yet). Optional: absent on the synthetic
// events tests construct + when no transcript is available (fail-open '').
export const PromptSubmitEvent = z.object({
  kind: z.literal('prompt_submit'),
  prompt: z.string(),
  priorAssistantText: z.string().optional(),
  // T-RJ-FOLLOWUPS FU.2 — the last N text-bearing turns (role-labeled), filled
  // by the UPS hook from the transcript. Consumed by the wedge-gate
  // `lesson-capture` skill via the `recent_turns` primitive; multi-turn context
  // (vs `priorAssistantText`'s single prior turn).
  recentTurns: z.string().optional(),
  // T-ATM ATM.2 — the OPEN tasks (latest status pending|in_progress) derived
  // from the transcript by the UPS hook (THIS CC version keeps the task list in
  // the transcript, not ~/.claude/tasks/). Consumed by Gate B
  // (`task_list_generated`) to flag tasks lacking `metadata.taskId` provenance.
  // Absent on synthetic test events + older CC (the function falls back to the
  // harness-store read).
  openTasks: z
    .array(z.object({ id: z.string(), status: z.string(), taskId: z.string().optional() }))
    .optional(),
});
export type PromptSubmitEvent = z.infer<typeof PromptSubmitEvent>;

export const SessionEndEvent = z.object({
  kind: z.literal('session_end'),
  sessionId: z.string(),
});
export type SessionEndEvent = z.infer<typeof SessionEndEvent>;

export const StopEvent = z.object({
  kind: z.literal('stop'),
  assistantText: z.string(),
});
export type StopEvent = z.infer<typeof StopEvent>;

// T-HANDOFF-HARDENING HH6.1 (2026-05-31) — SessionStart fires ONCE when a
// session begins (Claude Code's `SessionStart` hook, the missing enforcement
// point this track adds). `source` is the CC-supplied trigger: `startup`
// (new), `resume` (--resume/--continue), `clear` (/clear), `compact`
// (auto/manual compaction). The session-start bin acts only on startup|resume
// (skips clear|compact — those fire mid-session and would re-inject noise).
// `sessionId`/`cwd` are optional carriers (CC supplies them; the bin defaults
// cwd to process.cwd()). First consumer = the connection-check pack rule
// (HH6.2), which subscribes via `triggers: [{kind: session_start}]`.
export const SessionStartEvent = z.object({
  kind: z.literal('session_start'),
  source: z.enum(['startup', 'resume', 'clear', 'compact']),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
});
export type SessionStartEvent = z.infer<typeof SessionStartEvent>;

// ---------------------------------------------------------------------------
// AUTO.1 — non-tool-call event variants.
//
// The four variants below back the trigger sources that don't ride on a host
// tool-call hook: scheduler ticks (SCHED.1), webhook intakes (SCHED.2),
// inbound channel messages (AUTO.6), and file-change watchers (AUTO.5).
//
// Discriminator literals stay strict `z.literal(<value>)` (per task spec risk
// callout — `z.string()` would silently break narrowing inside `switch
// (event.kind)`). Carrier fields stay deliberately loose at this layer so
// downstream trigger sources can extend them without re-migrating every
// pinned cron job or webhook spec:
//
//   - `ScheduleEvent.triggerPayload` is `z.record(z.unknown())` — schedule
//     authors put what they want; tightening means migrating every cron job.
//   - `WebhookEvent.body` is `z.unknown()` — bodies are JSON, plaintext,
//     form-encoded, etc. The webhook intake (AUTO.6 / SCHED.2) is the right
//     layer to refine per-route.
//   - `WebhookEvent.headers` stays `z.record(z.string())` — headers are
//     always string-valued by HTTP spec, but key set is open.
//
// `receivedAt` / `fireTime` / `changedAt` are ISO-8601 strings authored by
// the trigger source. We don't `z.string().datetime()` them here because
// the trigger source (not the runtime) owns the time-of-truth — refining
// the format means surfacing bad-clock errors at the trigger boundary,
// which is a follow-up task (SCHED.1 + AUTO.5 land that boundary).
// ---------------------------------------------------------------------------

export const ScheduleEvent = z.object({
  kind: z.literal('schedule'),
  scheduleId: z.string(),
  fireTime: z.string(), // ISO-8601, authored by the scheduler tick (SCHED.1)
  triggerPayload: z.record(z.unknown()).default({}),
});
export type ScheduleEvent = z.infer<typeof ScheduleEvent>;

export const WebhookEvent = z.object({
  kind: z.literal('webhook'),
  subscriptionId: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  headers: z.record(z.string()),
  body: z.unknown(),
  receivedAt: z.string(),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const InboundChannelEvent = z.object({
  kind: z.literal('inbound_channel'),
  channelUri: z.string(), // e.g. "telegram://-1001234567890/42"
  sender: z.string(),
  text: z.string(),
  threadKey: z.string().optional(),
  receivedAt: z.string(),
});
export type InboundChannelEvent = z.infer<typeof InboundChannelEvent>;

export const FileChangedEvent = z.object({
  kind: z.literal('file_changed'),
  path: z.string(),
  changeKind: z.enum(['add', 'change', 'unlink']),
  changedAt: z.string(),
});
export type FileChangedEvent = z.infer<typeof FileChangedEvent>;

// ---------------------------------------------------------------------------
// Event — discriminated union on `kind`.
//
// The order below puts the host-hook events first (tool_call, post_tool_call,
// prompt_submit, session_end, stop, session_start) and the trigger-source
// events after, matching the load order in `EventKind` (see below) and the
// matcher allow-list in `load_matchers.ts`. Pack authors can declare any
// kind as a skill `triggers:` entry; the dispatcher filters skills
// per event kind before evaluating rules.
// ---------------------------------------------------------------------------

export const Event = z.discriminatedUnion('kind', [
  ToolCallEvent,
  PostToolCallEvent, // T-POSTPUSH POSTPUSH.1
  PromptSubmitEvent,
  SessionEndEvent,
  StopEvent,
  SessionStartEvent, // T-HANDOFF-HARDENING HH6.1
  ScheduleEvent,
  WebhookEvent,
  InboundChannelEvent,
  FileChangedEvent,
]);
export type Event = z.infer<typeof Event>;

// ---------------------------------------------------------------------------
// EventKind — the discriminator literals as a Zod enum + TS type.
//
// Lives next to `Event` so consumers that need the bare set of kinds
// (skill `triggers:`, load matchers' `event_type` filter, scheduler audit
// logs) import a single source of truth instead of re-typing the literals.
// ---------------------------------------------------------------------------

export const EventKind = z.enum([
  'tool_call',
  'post_tool_call', // T-POSTPUSH POSTPUSH.1
  'prompt_submit',
  'session_end',
  'stop',
  'session_start', // T-HANDOFF-HARDENING HH6.1
  'schedule',
  'webhook',
  'inbound_channel',
  'file_changed',
]);
export type EventKind = z.infer<typeof EventKind>;

// ---------------------------------------------------------------------------
// Trigger — discriminated union declaring which `Event` kinds fire a skill.
//
// AUTO.1: skills opt in to non-tool-call events via a `triggers:` block on
// the skill manifest. The runtime view declared here is the post-load
// (post-YAML-validation) shape; the YAML-side schema in
// `src/packs/schemas/skill.ts` re-uses this type so pack authors and the
// dispatcher see one canonical Trigger shape.
//
// Per-kind filter args at this layer:
//
//   tool_call / prompt_submit / session_end / stop
//     no filter args — the host hook delivers the event verbatim and
//     existing in-rule primitives (tool_name, match_command) do per-event
//     filtering.
//
//   schedule
//     `cron`      — POSIX-style schedule expression, read by SCHED.1
//     `cost_tier` — AUTO.7 cross-subscription routing hint
//
//   webhook
//     `path`      — URL path filter, read by SCHED.2 webhook intake
//     `cost_tier` — AUTO.7 cross-subscription routing hint
//
//   inbound_channel
//     `channel`   — abstract channel name (mapped to URI via channels.yaml),
//                   read by AUTO.6 inbound router
//     `cost_tier` — AUTO.7 cross-subscription routing hint
//
//   file_changed
//     `paths`     — glob list, read by AUTO.5 chokidar watcher
//     `ignored`   — glob list, read by AUTO.5 chokidar watcher
//     `cost_tier` — AUTO.7 cross-subscription routing hint
//
// Discriminator literals stay strict `z.literal(<value>)` (same risk
// callout as Event) so the dispatcher's `event.kind ∈ triggers.kind` filter
// narrows correctly inside a `switch`.
// ---------------------------------------------------------------------------

const CostTier = z.enum(['cheap', 'balanced', 'premium']);

export const Trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool_call') }),
  z.object({ kind: z.literal('post_tool_call') }), // T-POSTPUSH POSTPUSH.1
  z.object({ kind: z.literal('prompt_submit') }),
  z.object({ kind: z.literal('session_end') }),
  z.object({ kind: z.literal('stop') }),
  z.object({ kind: z.literal('session_start') }), // T-HANDOFF-HARDENING HH6.1
  z.object({
    kind: z.literal('schedule'),
    cron: z.string().optional(),
    cost_tier: CostTier.optional(),
  }),
  z.object({
    kind: z.literal('webhook'),
    path: z.string().optional(),
    cost_tier: CostTier.optional(),
  }),
  z.object({
    kind: z.literal('inbound_channel'),
    channel: z.string().optional(),
    // LL.3 (2026-05-30) — sender_pattern is OPTIONAL so existing skill
    // manifests parse unchanged. Compiled as JS RegExp at dispatch
    // time; malformed pattern → silent skip (filter returns false).
    // First-party pack manifests only — NOT a user-supplied input,
    // so JS RegExp is acceptable here (not RE2 — see pack-runtime.md
    // §7.5 anti-patterns).
    sender_pattern: z.string().optional(),
    cost_tier: CostTier.optional(),
  }),
  z.object({
    kind: z.literal('file_changed'),
    paths: z.array(z.string()).optional(),
    ignored: z.array(z.string()).optional(),
    cost_tier: CostTier.optional(),
  }),
]);
export type Trigger = z.infer<typeof Trigger>;

/**
 * Default trigger list applied when a skill omits the `triggers:` block.
 * Pinned to a single `tool_call` entry for back-compat with every Phase
 * 1–7 pack authored before AUTO.1 widened the Event union.
 */
export const DEFAULT_TRIGGERS: readonly Trigger[] = Object.freeze([
  Object.freeze({ kind: 'tool_call' as const }),
]);

/**
 * Build a fresh, mutable copy of the default trigger list — used by Zod
 * `.default(fn)` so each parsed skill gets its own array instance.
 */
export function defaultTriggers(): Trigger[] {
  return [{ kind: 'tool_call' }];
}
