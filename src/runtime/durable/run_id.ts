/**
 * Deterministic run_id derivation for durable execution (DURABLE.1).
 *
 * A `run_id` MUST be stable across daemon restarts so a crashed process can
 * resume from the exact same checkpoint stream. Given the same
 * `(pack, skill, ruleId, eventKind, eventPayload)`, `runIdFor` returns the
 * same SHA-256 hex string — both inside one node process and across cold
 * restarts.
 *
 * Stability requires canonical JSON. Object keys sort alphabetically, dates
 * serialize as ISO 8601, Buffer/Uint8Array serialize as a tagged base64
 * envelope, undefined properties drop (matching `JSON.stringify`). These
 * rules ALSO govern `outputs_json` storage in the checkpoint store — see
 * `canonical_json.ts`.
 *
 * Why hash the event payload instead of using it raw: events can carry
 * large or sensitive blobs (webhook bodies, file contents, LLM prompts).
 * Hashing keeps run_id short, opaque, and storage-friendly while still
 * giving us the stability guarantee.
 *
 * Imports from: node:crypto, ./canonical_json.js.
 * Imported by: src/runtime/durable/checkpoint_store.ts, future evaluator
 * wrap in DURABLE.2.
 */

import { createHash } from 'node:crypto';

import { canonicalJsonStringify } from './canonical_json.js';

/**
 * Inputs for `runIdFor`. All five fields participate in the hash; changing
 * any of them yields a different `run_id`. The `eventPayload` is hashed
 * (not embedded) — see module docstring.
 */
export interface RunIdInput {
  pack: string;
  skill: string;
  ruleId: string;
  eventKind: string;
  eventPayload: unknown;
}

/**
 * Deterministic SHA-256 over canonical JSON of the run identity. Returns
 * 64-char lowercase hex.
 *
 * Audit guarantee: the function is pure. No `Date.now`, no `Math.random`,
 * no env reads. Same input → same output across processes.
 */
export function runIdFor(input: RunIdInput): string {
  const eventHash = sha256Hex(canonicalJsonStringify(input.eventPayload));
  const identity = {
    pack: input.pack,
    skill: input.skill,
    ruleId: input.ruleId,
    eventKind: input.eventKind,
    eventHash,
  };
  return sha256Hex(canonicalJsonStringify(identity));
}

/**
 * SHA-256 over a UTF-8 string → lowercase hex. Centralized so every
 * hashing site in the durable module uses the same encoding.
 */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
