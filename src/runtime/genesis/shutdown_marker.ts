/**
 * GR.1 — the graceful-shutdown marker: the global classifier for reconcile.
 *
 * A graceful shutdown writes this sentinel (after persisting actor state). At the
 * next genesis the marker's PRESENCE ⇒ clean `resume`; its ABSENCE ⇒ crash ⇒
 * `recovery` mode. The marker is CONSUMED (deleted) on read so it is one-shot —
 * a stale marker from a prior clean run cannot mask a later crash.
 *
 * Spec: loop/docs/tasks/T-fsm-actor-runtime.md §GR.1.
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteFile } from '../atomic_write.js';
import { OPENSQUID_HOME } from '../paths.js';
import type { GenesisClassifier } from './reconcile.js';

export interface ShutdownMarker {
  status: 'clean';
  digest: string;
  ts: number;
}

export const shutdownMarkerPath = (home: string = OPENSQUID_HOME()): string =>
  join(home, 'shutdown.json');

/** Written by the daemon's graceful shutdown, AFTER persisting actor state. */
export async function writeShutdownMarker(
  digest: string,
  home: string = OPENSQUID_HOME(),
): Promise<void> {
  const marker: ShutdownMarker = { status: 'clean', digest, ts: Date.now() };
  await atomicWriteFile(shutdownMarkerPath(home), `${JSON.stringify(marker)}\n`);
}

/** Read WITHOUT consuming (test/inspection). Absent/corrupt ⇒ null (treated as crash). */
export async function readShutdownMarker(
  home: string = OPENSQUID_HOME(),
): Promise<ShutdownMarker | null> {
  try {
    const marker = JSON.parse(await readFile(shutdownMarkerPath(home), 'utf8')) as ShutdownMarker;
    return marker.status === 'clean' ? marker : null;
  } catch {
    return null;
  }
}

/** Read-and-CONSUME (one-shot): genesis uses this so a stale marker can't mask a crash. */
export async function consumeShutdownMarker(
  home: string = OPENSQUID_HOME(),
): Promise<ShutdownMarker | null> {
  const marker = await readShutdownMarker(home);
  if (marker) await rm(shutdownMarkerPath(home), { force: true });
  return marker;
}

/** The reconcile `GenesisClassifier` backed by the on-disk marker (consuming). */
export function markerClassifier(home: string = OPENSQUID_HOME()): GenesisClassifier {
  return { shutdownMarker: () => consumeShutdownMarker(home) };
}
