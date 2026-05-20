/**
 * State I/O primitives: `read_state`, `write_state`, `append_log`.
 *
 * Per `docs/opensquid-real-design.md` §"Phase 1 — Runtime skeleton" (state
 * surface). These three primitives are the only filesystem-touching
 * primitives in the Phase 1 runtime — skills compose them into rule
 * processes via YAML.
 *
 * Atomicity contract:
 *   - `write_state` uses tmp-file + rename (atomic on POSIX, near-atomic on
 *     Windows — rename over an open target fails there; documented risk).
 *   - `append_log` serializes concurrent writers via `proper-lockfile`
 *     (5 s stale timeout — minimum allowed by the lib). The file is
 *     touched before locking because `proper-lockfile` requires the
 *     target to exist.
 *
 * Error model: ENOENT on read returns `ok(null)` (canonical "no state"
 * signal — see `src.legacy/anti-drift/state.ts` for the original pattern).
 * Every other failure travels as `err({ kind: 'runtime', ... })`. Throws
 * never escape an `execute` — the evaluator's stray-throw wrapper is for
 * bugs, not for normal failure modes.
 *
 * Imports from: zod, node:fs/promises, node:path, proper-lockfile,
 *   ../runtime/paths.js, ./registry.js, ../runtime/result.js.
 * Imported by: src/functions/index.ts (registry wiring).
 */

import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import lockfile from 'proper-lockfile';
import { z } from 'zod';

import { packStateFile, sessionLogFile, sessionStateFile } from '../runtime/paths.js';
import { err, ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Zod arg schemas — `min(1)` on key/name to block empty-string foot-guns.
// `z.unknown()` on value/entry: state primitives are JSON-shape-agnostic by
// design; per-skill refinement happens at the YAML layer if needed.
//
// Optional `pack` (Task 5.3) — when present, state is namespaced under
// `~/.opensquid/packs/<id>/state/<key>.json`; when absent, falls back to
// session-scoped state under `~/.opensquid/sessions/<session-id>/state/`.
// Pack-id sanitization happens inside `packStateFile` (no `.` / `/` etc.).
// ---------------------------------------------------------------------------

const ReadStateArgs = z.object({ key: z.string().min(1), pack: z.string().min(1).optional() });
const WriteStateArgs = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  pack: z.string().min(1).optional(),
});
const AppendLogArgs = z.object({ name: z.string().min(1), entry: z.unknown() });

// ---------------------------------------------------------------------------
// atomicWriteJson — tmp-file + rename idiom.
//
// `${pid}.${ts}` suffix on the tmp file makes concurrent writers from
// different processes collision-proof. POSIX `rename(2)` is atomic; on
// Windows the rename fails if the target is open by another process —
// callers running on Windows should treat `write_state` as best-effort.
// ---------------------------------------------------------------------------

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// touchFile — ensure target exists so `proper-lockfile` can lock it.
//
// `proper-lockfile.lock()` rejects with ENOENT if the file is absent. We
// create the file empty (`'a'` flag = append, creates if missing, never
// truncates) and close the descriptor before locking, so the lock has a
// stable inode to attach `.lock` next to.
// ---------------------------------------------------------------------------

async function touchFile(path: string): Promise<void> {
  const fh = await open(path, 'a');
  await fh.close();
}

export function registerStateFunctions(registry: FunctionRegistry): void {
  registry.register({
    name: 'read_state',
    argSchema: ReadStateArgs,
    execute: async ({ key, pack }, ctx) => {
      // Optional `pack` arg routes to `~/.opensquid/packs/<id>/state/...`;
      // omitted = session-scoped fallback (unchanged Phase 1 semantics).
      const path = pack ? packStateFile(pack, key) : sessionStateFile(ctx.sessionId, key);
      try {
        const raw = await readFile(path, 'utf8');
        return ok(JSON.parse(raw) as unknown);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ok(null);
        return err({
          kind: 'runtime',
          message: `read_state(${key}): ${String(e)}`,
          cause: e,
        });
      }
    },
  });

  registry.register({
    name: 'write_state',
    argSchema: WriteStateArgs,
    execute: async ({ key, value, pack }, ctx) => {
      const path = pack ? packStateFile(pack, key) : sessionStateFile(ctx.sessionId, key);
      try {
        await atomicWriteJson(path, value);
        return ok(undefined);
      } catch (e: unknown) {
        return err({
          kind: 'runtime',
          message: `write_state(${key}): ${String(e)}`,
          cause: e,
        });
      }
    },
  });

  registry.register({
    name: 'append_log',
    argSchema: AppendLogArgs,
    execute: async ({ name, entry }, ctx) => {
      const path = sessionLogFile(ctx.sessionId, name);
      try {
        await mkdir(dirname(path), { recursive: true });
        await touchFile(path);
        // 5000ms is the minimum stale-lock timeout accepted by
        // proper-lockfile. Retries with exponential backoff so 10
        // concurrent writers serialize cleanly without timing out.
        const release = await lockfile.lock(path, {
          retries: { retries: 10, factor: 2, minTimeout: 20, maxTimeout: 200 },
          stale: 5000,
          realpath: false,
        });
        try {
          await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
          return ok(undefined);
        } finally {
          await release();
        }
      } catch (e: unknown) {
        return err({
          kind: 'runtime',
          message: `append_log(${name}): ${String(e)}`,
          cause: e,
        });
      }
    },
  });
}
