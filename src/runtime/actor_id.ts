/**
 * The op-log replica id (work-graph determinism, WGD.1). A per-HOME (per-device) UUID persisted at
 * `${OPENSQUID_HOME()}/actor-id`, used as the `actor-id` half of the `(lamport, actor-id)` tuple that
 * deterministically orders + content-addresses work-graph ops. One home = one device replica = one
 * actor (all worktrees/sessions on a machine share it); cloud sync merges op-logs across devices, and
 * distinct actor-ids keep colliding lamports across replicas distinct (collision-free merge).
 *
 * Imports from: node:crypto, node:fs/promises, node:path, ../storage/atomic_file.js, ./paths.js.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteFile } from '../storage/atomic_file.js';

import { OPENSQUID_HOME } from './paths.js';

let cached: string | null = null;

/** The op-log replica id — a per-HOME (per-device) UUID at `${OPENSQUID_HOME()}/actor-id`. Generated
 *  once on first call and persisted atomically; cached in-process thereafter. */
export async function resolveActorId(): Promise<string> {
  if (cached !== null) return cached;
  const path = join(OPENSQUID_HOME(), 'actor-id');
  let id: string;
  try {
    id = (await readFile(path, 'utf8')).trim();
    if (id === '') throw new Error('empty');
  } catch {
    id = randomUUID();
    await atomicWriteFile(path, id);
  }
  cached = id;
  return id;
}
