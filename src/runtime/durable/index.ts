/**
 * Durable execution module barrel (DURABLE.1 + DURABLE.2 + DURABLE.3).
 *
 * Public surface:
 *
 *   CheckpointStore        — libsql-backed per-primitive checkpoint persistence
 *   CheckpointWrite        — append() arg shape
 *   CheckpointRow          — row read back from the store
 *   runIdFor               — deterministic SHA-256 over run identity
 *   RunIdInput             — runIdFor input shape
 *   canonicalJsonStringify — sorted-key JSON with Date/Buffer envelopes
 *   canonicalJsonParse     — inverse, rehydrates base64 envelopes to Buffers
 *   MemoCache              — two-tier (LRU + libsql) memoization with singleflight
 *   MemoHit                — wrapper that disambiguates cached `null` from miss
 *   MemoStats              — per-primitive hit / size rows
 *   MemoCacheOpts          — construction options (memoryMax, nowMs)
 *
 * DURABLE.1 ships storage; DURABLE.2 wires the evaluator wrap; DURABLE.3
 * adds memoization on identical primitive inputs (memoizable: true).
 * DURABLE.4 (resumer that scans interrupted runs) is not yet wired.
 */

export { CheckpointStore, type CheckpointRow, type CheckpointWrite } from './checkpoint_store.js';
export { runIdFor, sha256Hex, type RunIdInput } from './run_id.js';
export { canonicalJsonStringify, canonicalJsonParse } from './canonical_json.js';
export { MemoCache, type MemoHit, type MemoStats, type MemoCacheOpts } from './memo_cache.js';
