/**
 * DAEMON.1 — runtime discovery state file (T-fsm-actor-runtime §DAEMON.1).
 *
 * `~/.opensquid/runtime.json` is how a thin client (hook / MCP / chat / ralph)
 * FINDS the running host: port + per-boot token + pid + start time. Written
 * atomically once the host has bound its port; unlinked on graceful shutdown.
 * Absent or corrupt ⇒ `null` (the client then auto-starts the host) — never throws.
 *
 * Mirrors gstack's state-file discovery (`browse/src/config.ts` state dir +
 * `browse.json`), in opensquid's Node/TS namespace, atop the project's
 * `atomicWriteFile` (no torn reads).
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteFile } from '../atomic_write.js';
import { OPENSQUID_HOME } from '../paths.js';

export interface RuntimeState {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

export const runtimeStatePath = (home: string = OPENSQUID_HOME()): string =>
  join(home, 'runtime.json');

/** Written AFTER the host binds its port (so a reader that sees the file can connect). */
export async function writeRuntimeState(
  state: RuntimeState,
  home: string = OPENSQUID_HOME(),
): Promise<void> {
  await atomicWriteFile(runtimeStatePath(home), `${JSON.stringify(state)}\n`);
}

/** Absent/corrupt ⇒ null (the client auto-starts). A present-but-partial file is also null. */
export async function readRuntimeState(
  home: string = OPENSQUID_HOME(),
): Promise<RuntimeState | null> {
  try {
    const raw = JSON.parse(await readFile(runtimeStatePath(home), 'utf8')) as Partial<RuntimeState>;
    if (
      typeof raw.port === 'number' &&
      typeof raw.token === 'string' &&
      raw.token.length > 0 &&
      typeof raw.pid === 'number' &&
      typeof raw.startedAt === 'number'
    ) {
      return raw as RuntimeState;
    }
    return null; // present but malformed ⇒ treat as no daemon
  } catch {
    return null;
  }
}

/** Remove the discovery file on graceful shutdown (idempotent — absent is fine). */
export async function unlinkRuntimeState(home: string = OPENSQUID_HOME()): Promise<void> {
  await rm(runtimeStatePath(home), { force: true });
}
