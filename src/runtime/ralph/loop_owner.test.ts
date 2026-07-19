import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';

import { loopPidPath } from '../paths.js';
import { readProcessIdentity } from '../processes/process_control.js';
import {
  acquireLoopOwner,
  loopOwnerEndpoint,
  probeLoopOwner,
  type LoopOwnerLease,
  type LoopOwnerProject,
} from './loop_owner.js';

const roots: string[] = [];
const leases: LoopOwnerLease[] = [];

afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<LoopOwnerProject> {
  const targetRepoRoot = await mkdtemp(join(tmpdir(), 'opensquid-loop-owner-'));
  roots.push(targetRepoRoot);
  const storeRoot = join(targetRepoRoot, '.opensquid');
  await mkdir(storeRoot);
  return { targetRepoRoot, storeRoot };
}

describe('loop lifetime owner', () => {
  it('derives a stable project-scoped endpoint', async () => {
    const a = await project();
    const b = await project();
    expect(loopOwnerEndpoint(a.targetRepoRoot)).toBe(loopOwnerEndpoint(a.targetRepoRoot));
    expect(loopOwnerEndpoint(a.targetRepoRoot)).not.toBe(loopOwnerEndpoint(b.targetRepoRoot));
  });

  it('admits one lifetime owner, repairs its projection, and releases endpoint authority on close', async () => {
    const p = await project();
    const first = await acquireLoopOwner(p);
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') throw new Error('expected acquired owner');
    leases.push(first.lease);
    expect(first.lease.isActive()).toBe(true);
    if (process.platform !== 'win32') {
      const endpointParent = await lstat(dirname(first.lease.endpoint));
      expect(endpointParent.mode & 0o077).toBe(0);
      if (typeof process.getuid === 'function') expect(endpointParent.uid).toBe(process.getuid());
    }

    const probe = await probeLoopOwner(p);
    expect(probe).toMatchObject({ kind: 'live', owner: { pid: process.pid } });
    const projection = JSON.parse(await readFile(loopPidPath(p.storeRoot), 'utf8')) as {
      pid: number;
      endpoint: string;
    };
    expect(projection).toEqual(
      expect.objectContaining({ pid: process.pid, endpoint: first.lease.endpoint }),
    );

    const loser = await acquireLoopOwner(p);
    expect(loser).toMatchObject({ status: 'occupied', owner: { pid: process.pid } });

    await first.lease.close();
    expect(first.lease.isActive()).toBe(false);
    leases.splice(0);
    expect(await probeLoopOwner(p)).toMatchObject({ kind: 'absent' });
    // A pid projection is non-authoritative derived data. Leaving it stale avoids a compare-then-unlink race
    // where the old owner could delete a successor's freshly written projection.
    expect(JSON.parse(await readFile(loopPidPath(p.storeRoot), 'utf8'))).toMatchObject({
      pid: process.pid,
    });
  });

  it('holds cross-process admission until close/crash and releases it after SIGKILL', async () => {
    const p = await project();
    const dbUrl = `file:${join(p.storeRoot, 'lock-proof.db')}`;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import{createClient}from'@libsql/client';` +
          `const db=createClient({url:process.env.DB_URL});` +
          `await db.execute('PRAGMA busy_timeout=100');` +
          `await db.execute('CREATE TABLE IF NOT EXISTS lock_proof(id INTEGER PRIMARY KEY)');` +
          `const tx=await db.transaction('write');process.stdout.write('ready\\n');setInterval(()=>void tx,1000);`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DB_URL: dbUrl },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    if (child.stdout === null) throw new Error('lock proof has no stdout');
    await once(child.stdout, 'data');
    const contender = createClient({ url: dbUrl });
    try {
      await contender.execute('PRAGMA busy_timeout=50');
      await expect(contender.transaction('write')).rejects.toThrow(/SQLITE_BUSY|locked/iu);
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
      const transaction = await contender.transaction('write');
      await transaction.rollback();
      transaction.close();
    } finally {
      contender.close();
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
    }
  });

  it('does not answer owner handshakes until predecessor/executor reconciliation completes', async () => {
    const p = await project();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beforeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = acquireLoopOwner(p, undefined, async () => {
      entered();
      await gate;
    });
    await beforeEntered;
    expect(await probeLoopOwner(p)).toMatchObject({ kind: 'absent' });
    release();
    const acquired = await pending;
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') throw new Error('expected acquired owner');
    leases.push(acquired.lease);
    expect(await probeLoopOwner(p)).toMatchObject({ kind: 'live', owner: { pid: process.pid } });
  });

  it('does not transfer claim capability while an exact prior loop process is still draining', async () => {
    const p = await project();
    const prior = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    if (prior.pid === undefined) throw new Error('prior process did not spawn');
    try {
      const identity = await readProcessIdentity(prior.pid);
      await writeFile(
        loopPidPath(p.storeRoot),
        `${JSON.stringify({
          version: 1,
          pid: prior.pid,
          processStartIdentity: identity.startIdentity,
          endpoint: loopOwnerEndpoint(p.targetRepoRoot),
        })}\n`,
      );
      const blocked = await acquireLoopOwner(p);
      expect(blocked.status).toBe('occupied');
      if (blocked.status !== 'occupied') throw new Error('expected occupied owner');
      expect(blocked.error).toContain('draining');
      expect(await probeLoopOwner(p)).toMatchObject({ kind: 'absent' });
    } finally {
      const closed = once(prior, 'close');
      prior.kill('SIGKILL');
      await closed;
    }
    const acquired = await acquireLoopOwner(p);
    expect(acquired.status).toBe('acquired');
    if (acquired.status === 'acquired') leases.push(acquired.lease);
  });

  it('repairs a missing pidfile from the validated endpoint handshake', async () => {
    const p = await project();
    const result = await acquireLoopOwner(p);
    if (result.status !== 'acquired') throw new Error('expected acquired owner');
    leases.push(result.lease);
    await unlink(loopPidPath(p.storeRoot));

    expect(await probeLoopOwner(p)).toMatchObject({ kind: 'live' });
    expect(JSON.parse(await readFile(loopPidPath(p.storeRoot), 'utf8'))).toMatchObject({
      pid: process.pid,
      processStartIdentity: result.lease.owner.processStartIdentity,
    });
  });

  it('ignores a stale pid projection when no endpoint owner exists', async () => {
    const p = await project();
    const stale = '{"version":1,"pid":999}\n';
    await writeFile(loopPidPath(p.storeRoot), stale);
    expect(await probeLoopOwner(p)).toMatchObject({ kind: 'absent' });
    expect(await readFile(loopPidPath(p.storeRoot), 'utf8')).toBe(stale);
  });

  it.runIf(process.platform !== 'win32')(
    'quarantines only an explicitly refused stale Unix socket before acquiring',
    async () => {
      const p = await project();
      const endpoint = loopOwnerEndpoint(p.targetRepoRoot);
      await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
      const script = join(p.targetRepoRoot, 'stale-socket.mjs');
      await writeFile(
        script,
        [
          `import { createServer } from 'node:net';`,
          `const server=createServer();`,
          `server.listen(${JSON.stringify(endpoint)},()=>process.stdout.write('ready\\n'));`,
          `setInterval(()=>{},1000);`,
        ].join('\n'),
      );
      const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
      await once(child.stdout, 'data');
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;

      const result = await acquireLoopOwner(p);
      expect(result.status).toBe('acquired');
      if (result.status === 'acquired') leases.push(result.lease);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'fails closed on an endpoint path that is not a socket and never deletes it',
    async () => {
      const p = await project();
      const endpoint = loopOwnerEndpoint(p.targetRepoRoot);
      await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
      await writeFile(endpoint, 'do not delete');
      const result = await acquireLoopOwner(p);
      expect(result).toMatchObject({ status: 'occupied' });
      expect(await readFile(endpoint, 'utf8')).toBe('do not delete');
      await unlink(endpoint);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'fails closed on an endpoint directory and never removes it',
    async () => {
      const p = await project();
      const endpoint = loopOwnerEndpoint(p.targetRepoRoot);
      await mkdir(endpoint, { recursive: true, mode: 0o700 });
      const result = await acquireLoopOwner(p);
      expect(result).toMatchObject({ status: 'occupied' });
      expect((await lstat(endpoint)).isDirectory()).toBe(true);
      await rm(endpoint, { recursive: true });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'fails closed on an endpoint symlink and preserves both link and target',
    async () => {
      const p = await project();
      const endpoint = loopOwnerEndpoint(p.targetRepoRoot);
      const target = join(p.targetRepoRoot, 'endpoint-target');
      await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
      await writeFile(target, 'do not delete');
      await symlink(target, endpoint);
      const result = await acquireLoopOwner(p);
      expect(result).toMatchObject({ status: 'occupied' });
      expect((await lstat(endpoint)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, 'utf8')).toBe('do not delete');
      await unlink(endpoint);
    },
  );
});
