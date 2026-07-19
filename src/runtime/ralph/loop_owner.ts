import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

import { createClient, type Client, type Transaction } from '@libsql/client';

import { atomicWriteFile } from '../atomic_write.js';
import { loopPidPath } from '../paths.js';
import { readProcessIdentity } from '../processes/process_control.js';

const OWNER_KIND = 'opensquid_loop_owner';
const OWNER_VERSION = 1;
const HANDSHAKE_LIMIT = 4096;
const DEFAULT_PROBE_TIMEOUT_MS = 750;
const OWNER_MAX_CONNECTIONS = 16;

export interface LoopOwnerProject {
  readonly targetRepoRoot: string;
  readonly storeRoot: string;
}

export interface LoopOwnerHandshake {
  readonly kind: typeof OWNER_KIND;
  readonly version: typeof OWNER_VERSION;
  readonly pid: number;
  readonly processStartIdentity: string;
}

export interface LoopOwnerProjection {
  readonly version: typeof OWNER_VERSION;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly endpoint: string;
}

export type LoopOwnerProbe =
  | { readonly kind: 'live'; readonly owner: LoopOwnerHandshake; readonly endpoint: string }
  | { readonly kind: 'absent'; readonly endpoint: string; readonly refused: boolean }
  | { readonly kind: 'compromised'; readonly endpoint: string; readonly error: string };

export interface LoopOwnerLease {
  readonly owner: LoopOwnerHandshake;
  readonly endpoint: string;
  readonly project: LoopOwnerProject;
  /** Synchronous fence checked immediately before every claim-capable WorkGraph operation. */
  isActive(): boolean;
  close(): Promise<void>;
}

export type AcquireLoopOwnerResult =
  | { readonly status: 'acquired'; readonly lease: LoopOwnerLease }
  | {
      readonly status: 'occupied';
      readonly endpoint: string;
      readonly owner?: LoopOwnerHandshake;
      readonly error?: string;
    };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function ownerUserKey(): string {
  if (typeof process.getuid === 'function') return `uid:${String(process.getuid())}`;
  const info = userInfo();
  return `username:${info.username}\u0000home:${info.homedir}`;
}

/** Project- and user-scoped kernel admission endpoint. */
export function loopOwnerEndpoint(
  canonicalProjectRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const digest = sha256(
    JSON.stringify([
      'opensquid-loop-owner',
      OWNER_VERSION,
      platform,
      canonicalProjectRoot,
      ownerUserKey(),
    ]),
  );
  if (platform === 'win32') return `\\\\.\\pipe\\osq-loop-${digest}`;
  const userDigest = sha256(ownerUserKey()).slice(0, 12);
  return join('/tmp', `osq-loop-${userDigest}`, `${digest}.sock`);
}

async function verifyEndpointDirectory(
  endpoint: string,
  create: boolean,
): Promise<'ready' | 'absent'> {
  if (process.platform === 'win32') return 'ready';
  const directory = dirname(endpoint);
  if (create) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`loop-owner endpoint parent is not a real directory: ${directory}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`loop-owner endpoint parent is not private: ${directory}`);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`loop-owner endpoint parent has the wrong owner: ${directory}`);
  }
  return 'ready';
}

function handshakeText(owner: LoopOwnerHandshake): string {
  return `${JSON.stringify({
    kind: owner.kind,
    version: owner.version,
    pid: owner.pid,
    processStartIdentity: owner.processStartIdentity,
  })}\n`;
}

function projectionText(owner: LoopOwnerHandshake, endpoint: string): string {
  return `${JSON.stringify({
    version: OWNER_VERSION,
    pid: owner.pid,
    processStartIdentity: owner.processStartIdentity,
    endpoint,
  })}\n`;
}

function decodeHandshake(value: string): LoopOwnerHandshake | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.kind !== OWNER_KIND ||
      parsed.version !== OWNER_VERSION ||
      !Number.isSafeInteger(parsed.pid) ||
      Number(parsed.pid) <= 0 ||
      typeof parsed.processStartIdentity !== 'string' ||
      parsed.processStartIdentity === ''
    ) {
      return null;
    }
    return {
      kind: OWNER_KIND,
      version: OWNER_VERSION,
      pid: Number(parsed.pid),
      processStartIdentity: parsed.processStartIdentity,
    };
  } catch {
    return null;
  }
}

async function validateHandshake(owner: LoopOwnerHandshake): Promise<boolean> {
  try {
    const identity = await readProcessIdentity(owner.pid);
    return identity.startIdentity === owner.processStartIdentity;
  } catch {
    return false;
  }
}

async function probeEndpoint(endpoint: string, timeoutMs: number): Promise<LoopOwnerProbe> {
  return new Promise<LoopOwnerProbe>((resolve) => {
    let settled = false;
    let connected = false;
    let body = '';
    const finish = (result: LoopOwnerProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const parse = async (line: string): Promise<void> => {
      const owner = decodeHandshake(line);
      if (owner === null || !(await validateHandshake(owner))) {
        finish({ kind: 'compromised', endpoint, error: 'invalid loop-owner handshake' });
        return;
      }
      finish({ kind: 'live', owner, endpoint });
    };
    const timer = setTimeout(() => {
      finish({ kind: 'compromised', endpoint, error: 'loop-owner probe timed out' });
    }, timeoutMs);

    const socket: Socket = createConnection(endpoint);
    socket.once('connect', () => {
      connected = true;
    });
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body, 'utf8') > HANDSHAKE_LIMIT) {
        finish({ kind: 'compromised', endpoint, error: 'loop-owner handshake exceeded limit' });
        return;
      }
      const newline = body.indexOf('\n');
      if (newline >= 0) void parse(body.slice(0, newline));
    });
    socket.once('end', () => {
      if (!settled) {
        const newline = body.indexOf('\n');
        if (newline >= 0) void parse(body.slice(0, newline));
        else finish({ kind: 'compromised', endpoint, error: 'loop-owner handshake ended early' });
      }
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      if (!connected && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) {
        finish({ kind: 'absent', endpoint, refused: error.code === 'ECONNREFUSED' });
        return;
      }
      finish({ kind: 'compromised', endpoint, error: error.message });
    });
  });
}

async function publishProjection(
  storeRoot: string,
  owner: LoopOwnerHandshake,
  endpoint: string,
): Promise<void> {
  await atomicWriteFile(loopPidPath(storeRoot), projectionText(owner, endpoint));
}

async function readProjectedOwner(storeRoot: string): Promise<LoopOwnerHandshake | null> {
  try {
    const value = JSON.parse(await readFile(loopPidPath(storeRoot), 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      value.version !== OWNER_VERSION ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.processStartIdentity !== 'string' ||
      value.processStartIdentity === ''
    ) {
      return null;
    }
    return {
      kind: OWNER_KIND,
      version: OWNER_VERSION,
      pid: Number(value.pid),
      processStartIdentity: value.processStartIdentity,
    };
  } catch {
    return null;
  }
}

export async function probeLoopOwner(
  project: LoopOwnerProject,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<LoopOwnerProbe> {
  const endpoint = loopOwnerEndpoint(project.targetRepoRoot);
  try {
    if ((await verifyEndpointDirectory(endpoint, false)) === 'absent') {
      return { kind: 'absent', endpoint, refused: false };
    }
  } catch (error) {
    return {
      kind: 'compromised',
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const result = await probeEndpoint(endpoint, timeoutMs);
  if (result.kind === 'live') {
    await publishProjection(project.storeRoot, result.owner, endpoint);
  }
  return result;
}

interface KernelAdmissionLock {
  readonly client: Client;
  readonly transaction: Transaction;
  close(): Promise<void>;
}

async function acquireKernelAdmissionLock(storeRoot: string): Promise<KernelAdmissionLock | null> {
  const client = createClient({ url: `file:${join(storeRoot, 'loop-owner-lock.db')}` });
  try {
    await client.execute('PRAGMA busy_timeout=100');
    await client.execute(
      'CREATE TABLE IF NOT EXISTS loop_owner_lock (id INTEGER PRIMARY KEY CHECK (id=1))',
    );
    const transaction = await client.transaction('write'); // BEGIN IMMEDIATE: kernel file lock held to close/crash
    return {
      client,
      transaction,
      close: async () => {
        if (!transaction.closed) await transaction.rollback().catch(() => undefined);
        transaction.close();
        client.close();
      },
    };
  } catch (error) {
    client.close();
    const code = (error as { code?: unknown }).code;
    if (
      code === 'SQLITE_BUSY' ||
      (error instanceof Error && /SQLITE_BUSY|database is locked/iu.test(error.message))
    ) {
      return null;
    }
    throw error;
  }
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.maxConnections = OWNER_MAX_CONNECTIONS;
    server.listen({ path: endpoint, backlog: OWNER_MAX_CONNECTIONS });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function quarantineRefusedSocket(endpoint: string): Promise<'retry' | 'gone' | 'unsafe'> {
  let stat;
  try {
    stat = await lstat(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw error;
  }
  // A regular file, directory, or symlink at the endpoint is not stale socket residue. Never rename/delete it;
  // return a fail-closed result so Linux ECONNREFUSED behavior cannot turn hostile path occupancy into a throw.
  if (!stat.isSocket()) return 'unsafe';
  const quarantine = `${endpoint}.stale.${String(process.pid)}.${randomUUID()}`;
  try {
    await rename(endpoint, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw error;
  }
  await unlink(quarantine).catch(() => undefined);
  return 'retry';
}

/**
 * Acquire the one kernel-owned admission endpoint before the worker can publish liveness or enter claims.
 * Connected-but-invalid endpoints fail closed; only an explicit POSIX ECONNREFUSED residue is quarantined.
 */
export async function acquireLoopOwner(
  project: LoopOwnerProject,
  onCompromised?: (error: Error) => void,
  beforeListen?: () => Promise<void>,
): Promise<AcquireLoopOwnerResult> {
  const endpoint = loopOwnerEndpoint(project.targetRepoRoot);
  await verifyEndpointDirectory(endpoint, true);

  // Fast-path an incumbent without contending on the lifetime lock.
  const initialProbe = await probeEndpoint(endpoint, DEFAULT_PROBE_TIMEOUT_MS);
  if (initialProbe.kind === 'live') {
    await publishProjection(project.storeRoot, initialProbe.owner, endpoint);
    return { status: 'occupied', endpoint, owner: initialProbe.owner };
  }
  if (initialProbe.kind === 'compromised') {
    return { status: 'occupied', endpoint, error: initialProbe.error };
  }

  // A separate SQLite BEGIN IMMEDIATE is the crash-released kernel lifetime lock. Only its holder may inspect,
  // quarantine, or bind the filesystem socket, eliminating stale-cleanup/bind TOCTOU between contenders.
  const admissionLock = await acquireKernelAdmissionLock(project.storeRoot);
  if (admissionLock === null) {
    const retryProbe = await probeEndpoint(endpoint, DEFAULT_PROBE_TIMEOUT_MS);
    if (retryProbe.kind === 'live') {
      await publishProjection(project.storeRoot, retryProbe.owner, endpoint);
      return { status: 'occupied', endpoint, owner: retryProbe.owner };
    }
    return {
      status: 'occupied',
      endpoint,
      error:
        retryProbe.kind === 'compromised'
          ? retryProbe.error
          : 'loop-owner lifetime lock is held while the owner endpoint starts or drains',
    };
  }

  let identity: Awaited<ReturnType<typeof readProcessIdentity>>;
  try {
    identity = await readProcessIdentity(process.pid);
  } catch (error) {
    await admissionLock.close();
    throw error;
  }
  const previousOwner = await readProjectedOwner(project.storeRoot);
  const owner: LoopOwnerHandshake = {
    kind: OWNER_KIND,
    version: OWNER_VERSION,
    pid: process.pid,
    processStartIdentity: identity.startIdentity,
  };

  // A lost legacy endpoint can become bindable before its old root drains. New-version incumbents retain the
  // kernel lock, while this exact projection fence handles transition from older installations.
  if (
    previousOwner !== null &&
    previousOwner.pid !== owner.pid &&
    (await validateHandshake(previousOwner))
  ) {
    await admissionLock.close();
    return {
      status: 'occupied',
      endpoint,
      error: `previous loop process ${String(previousOwner.pid)} is still draining`,
    };
  }

  try {
    await beforeListen?.();
  } catch (error) {
    await admissionLock.close();
    return {
      status: 'occupied',
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  for (;;) {
    const server = createServer((socket) => socket.end(handshakeText(owner)));
    try {
      await listen(server, endpoint);
    } catch (error) {
      await closeServer(server).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        await admissionLock.close();
        throw error;
      }
      const probe = await probeEndpoint(endpoint, DEFAULT_PROBE_TIMEOUT_MS);
      if (probe.kind === 'live') {
        await publishProjection(project.storeRoot, probe.owner, endpoint);
        await admissionLock.close();
        return { status: 'occupied', endpoint, owner: probe.owner };
      }
      if (probe.kind === 'compromised') {
        await admissionLock.close();
        return { status: 'occupied', endpoint, error: probe.error };
      }
      if (process.platform !== 'win32' && probe.refused) {
        const quarantine = await quarantineRefusedSocket(endpoint);
        if (quarantine === 'unsafe') {
          await admissionLock.close();
          return {
            status: 'occupied',
            endpoint,
            error: `loop-owner endpoint is not a socket: ${endpoint}`,
          };
        }
        continue;
      }
      await admissionLock.close();
      return { status: 'occupied', endpoint, error: 'loop-owner endpoint is unavailable' };
    }

    let closing = false;
    let compromised = false;
    let active = true;
    const compromise = (error: Error): void => {
      if (closing || compromised) return;
      active = false;
      compromised = true;
      onCompromised?.(error);
    };
    server.on('error', (error) => compromise(error));
    server.on('close', () => {
      if (!closing) compromise(new Error('loop-owner endpoint closed unexpectedly'));
    });
    await publishProjection(project.storeRoot, owner, endpoint);

    return {
      status: 'acquired',
      lease: {
        owner,
        endpoint,
        project,
        isActive: () => active && server.listening && !admissionLock.transaction.closed,
        close: async () => {
          if (closing) return;
          active = false;
          closing = true;
          await closeServer(server);
          await admissionLock.close();
        },
      },
    };
  }
}
