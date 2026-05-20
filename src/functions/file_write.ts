/**
 * `file_write` primitive — gated arbitrary-path file writer (AUTO.3).
 *
 * Distinct from `write_state` (in `./state.ts`), which writes ONLY into
 * `~/.opensquid/sessions/<id>/state/` or `~/.opensquid/packs/<id>/state/`.
 * `file_write` is the primitive that handles user-content writes (skill
 * outputs, generated reports, ingest results) and so must pass through
 * the capability gate.
 *
 * Atomicity: tmp-file + rename, same idiom as `state.atomicWriteJson`.
 *
 * Gate posture: the gate runs BEFORE the write — a denial returns an
 * `err({ kind: 'runtime', ... })` with the gate's audit message. The
 * filesystem is never touched on deny.
 *
 * Encoding: UTF-8 only at this layer. Binary writes are out of scope for
 * Phase 1; if needed, a future `file_write_binary` primitive lands with
 * a Base64-encoded `content` arg.
 *
 * Imports from: zod, node:fs/promises, node:path, ../runtime/result.js,
 *   ../runtime/capability_gate.js, ./registry.js.
 * Imported by: src/functions/index.ts (registry wiring).
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

import type { CapabilityGate } from '../runtime/capability_gate.js';
import { err, ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

const FileWriteArgs = z.object({
  path: z.string().min(1),
  content: z.string(),
});

async function atomicWriteText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, value, 'utf8');
  await rename(tmp, path);
}

/**
 * Register the `file_write` primitive. `cwd` resolves relative paths so
 * the gate sees an absolute path (built-in path denies use absolute
 * minimatch globs).
 */
export function registerFileWriteFunction(
  registry: FunctionRegistry,
  opts: { gate: CapabilityGate; cwd?: string },
): void {
  const baseDir = opts.cwd ?? process.cwd();
  registry.register({
    name: 'file_write',
    argSchema: FileWriteArgs,
    execute: async ({ path, content }, ctx) => {
      const absolute = isAbsolute(path) ? path : resolve(baseDir, path);
      const verdict = await opts.gate.check({
        pack: ctx.packId,
        capability: 'file_write',
        target: absolute,
        context: { sessionId: ctx.sessionId },
      });
      if (!verdict.allowed) {
        return err({
          kind: 'runtime' as const,
          message: `file_write denied: ${verdict.message ?? verdict.source}`,
        });
      }
      try {
        await atomicWriteText(absolute, content);
        return ok({ path: absolute, bytes: Buffer.byteLength(content, 'utf8') });
      } catch (e: unknown) {
        return err({
          kind: 'runtime' as const,
          message: `file_write(${path}): ${String(e)}`,
          cause: e,
        });
      }
    },
  });
}
