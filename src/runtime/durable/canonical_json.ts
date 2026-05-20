/**
 * Canonical JSON serialization for durable execution (DURABLE.1).
 *
 * Two requirements drive this module:
 *
 *   1. `run_id` derivation must be byte-stable across processes — JSON key
 *      order matters, so we sort keys recursively before stringifying.
 *
 *   2. Checkpoint outputs must round-trip through libsql `TEXT` storage and
 *      back into evaluator bindings. JavaScript values that `JSON.stringify`
 *      cannot losslessly handle (Date, Buffer / typed arrays) get tagged
 *      envelopes here and unwrapped on parse:
 *
 *        Date           → string  (ISO 8601)
 *        Buffer         → { __type: 'base64', data: '<base64>' }
 *        Uint8Array     → { __type: 'base64', data: '<base64>' }
 *
 * Anything `JSON.stringify` would normally drop (functions, symbols,
 * `undefined` values inside an object) is also dropped here, matching the
 * stdlib's behavior. Inside arrays, `undefined` becomes `null` — also
 * matching stdlib.
 *
 * Cycles raise a TypeError just like `JSON.stringify` would; primitive
 * authors must not return cyclic outputs.
 *
 * Imports from: nothing (Node stdlib only).
 * Imported by: ./run_id.ts, ./checkpoint_store.ts.
 */

interface Base64Envelope {
  __type: 'base64';
  data: string;
}

function isBase64Envelope(v: unknown): v is Base64Envelope {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  return rec.__type === 'base64' && typeof rec.data === 'string';
}

/**
 * Convert a value into the canonical-JSON-friendly shape. Recurses through
 * plain objects and arrays. Returns a value that's safe to feed to
 * `JSON.stringify` with sorted keys.
 *
 * `seen` is a WeakSet used for cycle detection. We raise instead of
 * silently breaking the cycle — durable checkpointing should fail loudly
 * if a primitive author shipped a cyclic output.
 */
function canonicalize(value: unknown, seen: WeakSet<object> = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (value instanceof Date) {
    return value.toISOString();
  }

  // Buffer (a Node Uint8Array subclass) and bare Uint8Array both serialize
  // to the same base64 envelope. Other typed arrays (Float32Array etc.)
  // would round-trip lossily so we deliberately do NOT special-case them;
  // primitive authors who need raw bytes must hand us a Buffer.
  if (value instanceof Uint8Array) {
    return { __type: 'base64', data: Buffer.from(value).toString('base64') };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('canonical-json: cyclic array');
    seen.add(value);
    const out = value.map((v) => (v === undefined ? null : canonicalize(v, seen)));
    seen.delete(value);
    return out;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('canonical-json: cyclic object');
    seen.add(value);
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      if (v === undefined) continue; // match JSON.stringify
      out[key] = canonicalize(v, seen);
    }
    seen.delete(value);
    return out;
  }

  // string | number | boolean | bigint | function | symbol — only the
  // first three round-trip through JSON. bigint throws inside
  // JSON.stringify; function and symbol silently drop. We let
  // JSON.stringify enforce that contract to avoid duplicating its checks.
  return value;
}

/**
 * Canonical JSON: sorted keys, dates/buffers tagged, deterministic byte
 * output. Drop-in replacement for `JSON.stringify(x)` when stability is
 * required.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Inverse of `canonicalJsonStringify` for the tagged-envelope shapes.
 * Plain JSON shapes (string, number, boolean, null, object, array) pass
 * through unchanged.
 *
 * Date envelopes intentionally do NOT exist — we collapsed `Date` to its
 * ISO string on write because the consumer (binding lookup, downstream
 * primitive) can re-parse with `new Date(str)` if needed. Forcing every
 * string-looking ISO to a Date on the read side would mis-restore strings
 * that just happen to look like dates.
 */
export function canonicalJsonParse(text: string): unknown {
  const raw = JSON.parse(text) as unknown;
  return revive(raw);
}

function revive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(revive);
  if (typeof value === 'object') {
    if (isBase64Envelope(value)) {
      return Buffer.from(value.data, 'base64');
    }
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      out[key] = revive(src[key]);
    }
    return out;
  }
  return value;
}
