/**
 * Durable execution module barrel (DURABLE.1 + DURABLE.2 + DURABLE.3 + DURABLE.4).
 *
 * Public surface:
 *
 *   CheckpointStore        — libsql-backed per-primitive checkpoint persistence
 *                            + run-manifest + terminal-marker tables (DURABLE.4)
 *   CheckpointWrite        — append() arg shape
 *   CheckpointRow          — row read back from the store
 *   RunManifest            — manifest written by the rule dispatcher at run-start
 *   InterruptedSummary     — scanInterrupted() row (one per resumable run)
 *   runIdFor               — deterministic SHA-256 over run identity
 *   RunIdInput             — runIdFor input shape
 *   canonicalJsonStringify — sorted-key JSON with Date/Buffer envelopes
 *   canonicalJsonParse     — inverse, rehydrates base64 envelopes to Buffers
 *   MemoCache              — two-tier (LRU + libsql) memoization with singleflight
 *   MemoHit                — wrapper that disambiguates cached `null` from miss
 *   MemoStats              — per-primitive hit / size rows
 *   MemoCacheOpts          — construction options (memoryMax, nowMs)
 *   Resumer                — scans interrupted runs + resumes from last completed step
 *   InterruptedRun         — Resumer's per-run input shape (joined manifest + summary)
 *   RuleResolver           — callback that resolves (packId, skill, ruleId) → process steps
 *   RunEvaluator           — callback that runs the evaluator for a resume pass
 *   ResumeAuditSink        — audit log surface for resume decisions
 *
 * DURABLE.1 ships storage; DURABLE.2 wires the evaluator wrap; DURABLE.3
 * adds memoization on identical primitive inputs; DURABLE.4 adds the
 * Resumer + restart-safe daemon hook so interrupted runs replay from
 * their last completed step on the next daemon boot.
 */

export {
  CheckpointStore,
  type CheckpointRow,
  type CheckpointWrite,
  type InterruptedSummary,
  type RunManifest,
  type TaskCheckpoint,
} from './checkpoint_store.js';
export { runIdFor, sha256Hex, type RunIdInput } from './run_id.js';
export { canonicalJsonStringify, canonicalJsonParse } from './canonical_json.js';
export { MemoCache, type MemoHit, type MemoStats, type MemoCacheOpts } from './memo_cache.js';
export {
  Resumer,
  DEFAULT_RESUME_WINDOW_MS,
  type AuditEntry as ResumeAuditEntry,
  type AuditSink as ResumeAuditSink,
  type InterruptedRun,
  type ResolvedRule,
  type ResumeOpts,
  type ResumeResult,
  type ResumeStartupResult,
  type RuleResolver,
  type RunEvaluator,
  type RunEvaluatorInput,
  type SkipReason as ResumeSkipReason,
} from './resumer.js';
