import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { createClient, type Client, type Transaction } from '@libsql/client';

import { atomicWriteFile } from './atomic_write.js';
import { resolveCheckpointKey } from './loop/checkpoint_key.js';
import { OPENSQUID_HOME } from './paths.js';

const AUDIT_FANOUT_SLOTS = 2;
const AUDIT_CACHE_LOCK_SLOTS = 64;
const ADMISSION_BUSY_TIMEOUT_MS = 100;
const ACTIVITY_FAST_PATH_MS = 660_000;
const ACTIVITY_CLOCK_SKEW_MS = 1_000;

interface KernelLock {
  readonly slot: number;
  readonly target: string;
  readonly client: Client;
  readonly transaction: Transaction;
}

interface AdmissionProjection {
  readonly token: string;
  readonly sessionId: string;
  readonly slot: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

type ReadProjection = AdmissionProjection;

export interface AuditActivityResult {
  readonly active: boolean;
  readonly unknown: boolean;
  readonly probedFiles: readonly string[];
}

type SlotProbe =
  | { readonly kind: 'locked' }
  | { readonly kind: 'free'; readonly guard: KernelLock }
  | { readonly kind: 'unknown' };

type ProjectionRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly value: ReadProjection }
  | { readonly kind: 'unknown' };

type RecoveryRemoval =
  | { readonly kind: 'removed' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'error' };

function admissionDir(): string {
  return join(OPENSQUID_HOME(), 'audit-admission');
}

function admissionTarget(slot: number): string {
  return join(admissionDir(), `slot-${String(slot)}.db`);
}

function activityPath(slot: number): string {
  return join(admissionDir(), `activity-slot-${String(slot)}.json`);
}

function isBusy(error: unknown): boolean {
  return (
    (error as { code?: unknown }).code === 'SQLITE_BUSY' ||
    (error instanceof Error && /SQLITE_BUSY|database is locked/iu.test(error.message))
  );
}

async function tryAcquire(target: string, slot: number): Promise<KernelLock | null> {
  const client = createClient({ url: `file:${target}` });
  try {
    await client.execute(`PRAGMA busy_timeout=${String(ADMISSION_BUSY_TIMEOUT_MS)}`);
    const transaction = await client.transaction('write');
    return { slot, target, client, transaction };
  } catch (error) {
    client.close();
    if (isBusy(error)) return null;
    throw error;
  }
}

async function releaseFailSoft(lock: KernelLock): Promise<void> {
  try {
    if (!lock.transaction.closed) await lock.transaction.rollback().catch(() => undefined);
  } catch {
    // Continue to close both handles; cleanup never replaces work outcome.
  }
  try {
    lock.transaction.close();
  } catch {
    // Already closed or connection-aborted.
  }
  try {
    lock.client.close();
  } catch {
    // Already closed. Holder exit also releases the underlying transaction.
  }
}

async function probeSlot(target: string, slot: number): Promise<SlotProbe> {
  try {
    const guard = await tryAcquire(target, slot);
    return guard === null ? { kind: 'locked' } : { kind: 'free', guard };
  } catch {
    return { kind: 'unknown' };
  }
}

async function readProjection(path: string): Promise<ProjectionRead> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AdmissionProjection>;
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      !Number.isInteger(parsed.slot) ||
      typeof parsed.createdAtMs !== 'number' ||
      !Number.isFinite(parsed.createdAtMs) ||
      typeof parsed.expiresAtMs !== 'number' ||
      !Number.isFinite(parsed.expiresAtMs) ||
      parsed.expiresAtMs - parsed.createdAtMs !== ACTIVITY_FAST_PATH_MS
    ) {
      return { kind: 'unknown' };
    }
    return {
      kind: 'valid',
      value: {
        token: parsed.token,
        sessionId: parsed.sessionId,
        slot: parsed.slot!,
        createdAtMs: parsed.createdAtMs,
        expiresAtMs: parsed.expiresAtMs,
      },
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unknown' };
  }
}

async function removeProjectionIfStillEqual(
  path: string,
  owner: AdmissionProjection,
): Promise<RecoveryRemoval> {
  try {
    const current = await readProjection(path);
    if (current.kind === 'absent') return { kind: 'removed' };
    if (current.kind !== 'valid') return { kind: 'error' };
    if (
      current.value.token !== owner.token ||
      current.value.sessionId !== owner.sessionId ||
      current.value.slot !== owner.slot ||
      current.value.createdAtMs !== owner.createdAtMs ||
      current.value.expiresAtMs !== owner.expiresAtMs
    ) {
      return { kind: 'changed' };
    }
    await unlink(path);
    return { kind: 'removed' };
  } catch {
    return { kind: 'error' };
  }
}

async function removeProjectionIfOwned(path: string, owner: AdmissionProjection): Promise<void> {
  try {
    const current = await readProjection(path);
    if (
      current.kind === 'valid' &&
      current.value.token === owner.token &&
      current.value.sessionId === owner.sessionId &&
      current.value.slot === owner.slot &&
      current.value.createdAtMs === owner.createdAtMs &&
      current.value.expiresAtMs === owner.expiresAtMs
    ) {
      await unlink(path);
    }
  } catch {
    // Fail-soft projection cleanup; transaction release remains in the caller's finally.
  }
}

/**
 * One canonical machine-local admission boundary. Two independent SQLite
 * BEGIN-IMMEDIATE transactions cap all processes sharing OPENSQUID_HOME at two
 * fan-outs/eight reviewers. A paused holder retains ownership and holder exit
 * releases it; there is no stale lease, wait queue, or compare-and-delete lock.
 */
export async function withAuditFanoutAdmission<T>(
  sessionId: string,
  work: () => Promise<T>,
): Promise<T> {
  await mkdir(admissionDir(), { recursive: true });
  let owned: KernelLock | null = null;
  for (let slot = 0; slot < AUDIT_FANOUT_SLOTS && owned === null; slot += 1) {
    owned = await tryAcquire(admissionTarget(slot), slot);
  }
  if (owned === null) {
    throw new Error(
      `audit fan-out admission full (${String(AUDIT_FANOUT_SLOTS)} concurrent invocations)`,
    );
  }
  let projection: AdmissionProjection | null = null;
  try {
    // Owner/token construction belongs inside the release fence: even entropy/clock/object construction failure
    // after acquisition takes acquired → releasing → released.
    const createdAtMs = Date.now();
    projection = {
      token: randomUUID(),
      sessionId,
      slot: owned.slot,
      createdAtMs,
      expiresAtMs: createdAtMs + ACTIVITY_FAST_PATH_MS,
    };
    // The kernel owner may replace only its fixed slot projection. This overwrites any orphan left after a
    // predecessor process died, so projection files remain globally bounded at two.
    await atomicWriteFile(activityPath(owned.slot), JSON.stringify(projection));
    return await work();
  } finally {
    try {
      if (projection !== null) await removeProjectionIfOwned(activityPath(owned.slot), projection);
    } finally {
      await releaseFailSoft(owned);
    }
  }
}

/**
 * Normal admission/release pushes two fixed machine-local projection files with explicit created/expires
 * state. Only an expired/future projection for the requested session enters crash-recovery lock probing. A free probe is
 * held through compare/delete, blocking successor publication; a busy probe is
 * deliberately `unknown` because a stale projection cannot identify the current
 * holder. Generic liveness treats unknown fail-closed.
 */
export async function readAuditActivity(
  sessionId: string,
  nowMs: number,
): Promise<AuditActivityResult> {
  const probedFiles: string[] = [];
  let active = false;
  let unknown = false;
  for (let slot = 0; slot < AUDIT_FANOUT_SLOTS; slot += 1) {
    const path = activityPath(slot);
    probedFiles.push(`audit:projection:${String(slot)}`);
    const marker = await readProjection(path);
    if (marker.kind === 'absent') continue;
    if (marker.kind === 'unknown') {
      unknown = true;
      continue;
    }
    if (marker.value.slot !== slot) {
      unknown = true;
      continue;
    }
    // A fixed slot can legitimately project another session's current work; that says nothing about the
    // requested session and is neither activity nor uncertainty for it.
    if (marker.value.sessionId !== sessionId) continue;
    if (
      nowMs >= marker.value.createdAtMs - ACTIVITY_CLOCK_SKEW_MS &&
      nowMs < marker.value.expiresAtMs
    ) {
      active = true;
      continue;
    }

    const target = admissionTarget(slot);
    probedFiles.push(`audit:recovery:${String(slot)}`);
    try {
      await mkdir(admissionDir(), { recursive: true });
    } catch {
      unknown = true;
      continue;
    }
    const probe = await probeSlot(target, slot);
    if (probe.kind === 'unknown' || probe.kind === 'locked') {
      unknown = true;
      continue;
    }
    try {
      const removal = await removeProjectionIfStillEqual(path, marker.value);
      if (removal.kind !== 'removed') unknown = true;
    } finally {
      await releaseFailSoft(probe.guard);
    }
  }
  return { active, unknown, probedFiles };
}

/**
 * One in-flight fan-out per canonical task/cache key. The key hashes into one
 * of 64 fixed SQLite transaction slots, bounding files permanently; same-key
 * calls always collide, while rare different-key collisions fail safe/fast.
 * Ownership spans cache classification through durable evidence write.
 */
export async function withAuditCacheKeyLock<T>(
  sessionId: string,
  cacheKey: string,
  work: () => Promise<T>,
): Promise<T> {
  const taskId = await resolveCheckpointKey(sessionId);
  if (taskId === null) throw new Error('audit cache lock requires canonical task identity');
  const dir = join(OPENSQUID_HOME(), 'audit-cache-locks');
  await mkdir(dir, { recursive: true });
  const digest = createHash('sha256').update(`${taskId}\n${cacheKey}`).digest();
  const slot = digest.readUInt32BE(0) % AUDIT_CACHE_LOCK_SLOTS;
  const owned = await tryAcquire(join(dir, `slot-${String(slot).padStart(2, '0')}.db`), slot);
  if (owned === null) throw new Error(`audit cache key is already in flight: ${cacheKey}`);
  try {
    return await work();
  } finally {
    await releaseFailSoft(owned);
  }
}
