/**
 * Durable execution module barrel (DURABLE.1).
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
 *
 * DURABLE.1 ships storage only. The evaluator wrap that calls
 * `CheckpointStore.append` around every primitive invocation is DURABLE.2;
 * the resumer that scans interrupted runs at daemon start is DURABLE.4.
 */

export { CheckpointStore, type CheckpointRow, type CheckpointWrite } from './checkpoint_store.js';
export { runIdFor, sha256Hex, type RunIdInput } from './run_id.js';
export { canonicalJsonStringify, canonicalJsonParse } from './canonical_json.js';
