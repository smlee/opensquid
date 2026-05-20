/**
 * `http_request` primitive — gated HTTP fetch stub (AUTO.3).
 *
 * Like `shell_exec.ts`, AUTO.3 lands the GATE only. The actual fetch
 * (timeout, retry policy, body framing, redirect handling, response-size
 * cap) lands in SCHED.1 / AUTO.6 — until then, this primitive performs the
 * gate check, returns a verdict-routed error on deny, and emits a
 * `not-implemented` error on allow.
 *
 * The gate sees both `url` and `method` — method matching is part of the
 * pack's `http_request.methods:` declaration, so the primitive forwards
 * the method as `req.method` for the gate to honour.
 *
 * Imports from: zod, ../runtime/result.js, ../runtime/capability_gate.js,
 *   ./registry.js.
 * Imported by: src/functions/index.ts (registry wiring).
 */

import { z } from 'zod';

import type { CapabilityGate } from '../runtime/capability_gate.js';
import { err } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

const HttpRequestArgs = z.object({
  url: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
});

export function registerHttpRequestFunction(
  registry: FunctionRegistry,
  opts: { gate: CapabilityGate },
): void {
  registry.register({
    name: 'http_request',
    argSchema: HttpRequestArgs,
    execute: async ({ url, method }, ctx) => {
      const verdict = await opts.gate.check({
        pack: ctx.packId,
        capability: 'http_request',
        target: url,
        method: method ?? 'GET',
        context: { sessionId: ctx.sessionId },
      });
      if (!verdict.allowed) {
        return err({
          kind: 'runtime' as const,
          message: `http_request denied: ${verdict.message ?? verdict.source}`,
        });
      }
      return err({
        kind: 'runtime' as const,
        message: `http_request gate-allowed but fetch is deferred to SCHED.1/AUTO.6: ${method} "${url}"`,
      });
    },
  });
}
