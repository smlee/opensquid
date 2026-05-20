/**
 * `shell_exec` primitive — gated shell-command execution stub (AUTO.3).
 *
 * AUTO.3 lands the CAPABILITY GATE only. The actual exec path (spawn/argv
 * separation, stdout/stderr capture, timeout, signal handling) lands in
 * AUTO.5 — until then, this primitive performs the gate check, returns a
 * verdict-routed error on deny, and emits a `not-implemented` error on
 * allow so that downstream callers can't accidentally bypass the future
 * exec wiring.
 *
 * The "stub but gated" posture is intentional — wiring the gate now means
 * AUTO.5 inherits the security model and only has to add the spawn layer.
 *
 * Imports from: zod, ../runtime/result.js, ../runtime/capability_gate.js,
 *   ./registry.js.
 * Imported by: src/functions/index.ts (registry wiring).
 */

import { z } from 'zod';

import type { CapabilityGate } from '../runtime/capability_gate.js';
import { err } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

const ShellExecArgs = z.object({
  command: z.string().min(1),
});

export function registerShellExecFunction(
  registry: FunctionRegistry,
  opts: { gate: CapabilityGate },
): void {
  registry.register({
    name: 'shell_exec',
    argSchema: ShellExecArgs,
    execute: async ({ command }, ctx) => {
      const verdict = await opts.gate.check({
        pack: ctx.packId,
        capability: 'shell_exec',
        target: command,
        context: { sessionId: ctx.sessionId },
      });
      if (!verdict.allowed) {
        return err({
          kind: 'runtime' as const,
          message: `shell_exec denied: ${verdict.message ?? verdict.source}`,
        });
      }
      // AUTO.5 wires the real spawn path. Returning runtime-error on allow
      // keeps callers from accidentally relying on a stub.
      return err({
        kind: 'runtime' as const,
        message: `shell_exec gate-allowed but exec is deferred to AUTO.5: "${command}"`,
      });
    },
  });
}
