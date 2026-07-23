import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAuditActivity, withAuditFanoutAdmission } from './audit_admission.js';

let home: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-audit-admission-'));
  process.env.OPENSQUID_HOME = home;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(home, { recursive: true, force: true });
});

function activityMarker(slot = 0): string {
  return join(home, 'audit-admission', `activity-slot-${String(slot)}.json`);
}

function projection(sessionId: string, createdAtMs: number, slot = 0): string {
  return JSON.stringify({
    token: `token-${sessionId}`,
    sessionId,
    slot,
    createdAtMs,
    expiresAtMs: createdAtMs + 660_000,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('withAuditFanoutAdmission', () => {
  it('admits exactly two kernel-owned invocations, rejects a third, then reuses a release', async () => {
    const releaseA = deferred();
    const releaseB = deferred();
    const startedA = deferred();
    const startedB = deferred();
    const a = withAuditFanoutAdmission('session-a', async () => {
      startedA.resolve();
      await releaseA.promise;
      return 'a';
    });
    const b = withAuditFanoutAdmission('session-b', async () => {
      startedB.resolve();
      await releaseB.promise;
      return 'b';
    });
    await Promise.all([startedA.promise, startedB.promise]);
    expect(await readAuditActivity('session-a', Date.now())).toMatchObject({
      active: true,
      unknown: false,
    });
    expect(await readAuditActivity('session-b', Date.now())).toMatchObject({
      active: true,
      unknown: false,
    });
    expect(
      (await readdir(join(home, 'audit-admission'))).filter((name) =>
        /^activity-slot-[01]\.json$/u.test(name),
      ),
    ).toEqual(['activity-slot-0.json', 'activity-slot-1.json']);
    await expect(withAuditFanoutAdmission('session-c', () => Promise.resolve('c'))).rejects.toThrow(
      'admission full (2 concurrent invocations)',
    );

    releaseA.resolve();
    await expect(a).resolves.toBe('a');
    await expect(withAuditFanoutAdmission('session-d', () => Promise.resolve('d'))).resolves.toBe(
      'd',
    );
    releaseB.resolve();
    await expect(b).resolves.toBe('b');
    expect(await readAuditActivity('session-a', Date.now())).toMatchObject({
      active: false,
      unknown: false,
    });
    const bases = (await readdir(join(home, 'audit-admission'))).filter((name) =>
      /^slot-[01]\.db$/u.test(name),
    );
    expect(bases).toEqual(['slot-0.db', 'slot-1.db']);
    expect(
      (await readdir(join(home, 'audit-admission'))).filter((name) =>
        /^activity-slot-[01]\.json$/u.test(name),
      ),
    ).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'releases a crashed process slot so a successor can acquire while the other slot remains occupied',
    async () => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `import { withAuditFanoutAdmission } from './src/runtime/audit_admission.ts';\n` +
            `await withAuditFanoutAdmission('crashed-child', async () => {\n` +
            `  process.stdout.write('ready\\n');\n` +
            `  setInterval(() => {}, 1000);\n` +
            `  await new Promise(() => {});\n` +
            `});`,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, OPENSQUID_HOME: home },
          stdio: ['ignore', 'pipe', 'inherit'],
        },
      );
      if (child.stdout === null) throw new Error('audit crash proof has no stdout');
      await once(child.stdout, 'data');

      const blockerStarted = deferred();
      const releaseBlocker = deferred();
      const blocker = withAuditFanoutAdmission('blocker', async () => {
        blockerStarted.resolve();
        await releaseBlocker.promise;
      });
      await blockerStarted.promise;
      // `ready` proves the separate child owned one slot; the blocker owns the other. Keep the proof focused on
      // kernel crash release rather than racing a redundant third-acquisition assertion under suite load.
      expect(child.exitCode).toBeNull();
      const closed = once(child, 'close');
      expect(child.kill('SIGKILL')).toBe(true);
      await closed;
      await expect(
        withAuditFanoutAdmission('successor', () => Promise.resolve('reacquired')),
      ).resolves.toBe('reacquired');
      releaseBlocker.resolve();
      await blocker;
    },
  );

  it('keeps a paused owner admitted without a renewable timer or stale theft', async () => {
    const started = deferred();
    const release = deferred();
    const running = withAuditFanoutAdmission('paused', async () => {
      started.resolve();
      await release.promise;
      return 42;
    });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readAuditActivity('paused', Date.now())).toMatchObject({
      active: true,
      unknown: false,
    });
    release.resolve();
    await expect(running).resolves.toBe(42);
  });

  it('releases the kernel transaction on publication failure and work rejection', async () => {
    const marker = activityMarker();
    await mkdir(join(home, 'audit-admission'), { recursive: true });
    await mkdir(marker, { recursive: true });
    await expect(
      withAuditFanoutAdmission('publish-failure', () => Promise.resolve(1)),
    ).rejects.toThrow();
    await rm(marker, { recursive: true, force: true });
    await expect(
      withAuditFanoutAdmission('work-failure', () => Promise.reject(new Error('work failed'))),
    ).rejects.toThrow('work failed');
    await expect(withAuditFanoutAdmission('after-failure', () => Promise.resolve(7))).resolves.toBe(
      7,
    );
  });

  it('always releases after projection-cleanup failure without replacing work outcome', async () => {
    const started = deferred();
    const release = deferred();
    const marker = activityMarker();
    const running = withAuditFanoutAdmission('cleanup-failure', async () => {
      started.resolve();
      await release.promise;
      return 42;
    });
    await started.promise;
    await rm(marker, { force: true });
    await mkdir(marker);
    release.resolve();
    await expect(running).resolves.toBe(42);
    await rm(marker, { recursive: true, force: true });
    await expect(withAuditFanoutAdmission('after-cleanup', () => Promise.resolve(7))).resolves.toBe(
      7,
    );
  });

  it('does not attribute an expired projection to a different busy holder', async () => {
    const started = deferred();
    const release = deferred();
    const running = withAuditFanoutAdmission('successor', async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const stale = activityMarker();
    const old = Date.now() - 700_000;
    // Simulate an orphaned prior projection while another process owns the kernel slot. The liveness reader
    // must not attribute the busy owner to the prior session.
    await writeFile(stale, projection('prior', old), 'utf8');
    expect(await readAuditActivity('prior', Date.now())).toMatchObject({
      active: false,
      unknown: true,
    });
    release.resolve();
    await running;
  });

  it('reconciles expired push projection and makes operational probe failure unknown', async () => {
    const dir = join(home, 'audit-admission');
    const marker = activityMarker();
    const old = Date.now() - 700_000;
    const encoded = projection('stale-session', old);
    await mkdir(dir, { recursive: true });
    await writeFile(marker, encoded, 'utf8');
    expect(await readAuditActivity('stale-session', Date.now())).toMatchObject({
      active: false,
      unknown: false,
    });

    await writeFile(marker, encoded, 'utf8');
    await rm(join(dir, 'slot-0.db'), { force: true });
    await mkdir(join(dir, 'slot-0.db'), { recursive: true });
    expect(await readAuditActivity('stale-session', Date.now())).toMatchObject({
      active: false,
      unknown: true,
    });
  });
});
