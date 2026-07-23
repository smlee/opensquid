/**
 * subscriptionCliStrategy — timeout contract (T-AUDIT-SPAWN-FIX).
 *
 * The timeout rejection must be the TYPED `CliTimeoutError` (callers like
 * cached_audit's spawn ledger classify by type), with the message text
 * byte-identical to the historical `timeout after Xms` string.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliTimeoutError, subscriptionCliStrategy } from './subscription_cli.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'opensquid-subscription-cli-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('subscriptionCliStrategy timeout', () => {
  it('rejects with CliTimeoutError and reclaims the real timed-out child', async () => {
    const script = join(tmpRoot, 'hang.js');
    const pidFile = join(tmpRoot, 'hang.pid');
    await writeFile(
      script,
      "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);",
      'utf8',
    );
    const strategy = subscriptionCliStrategy({
      mode: 'subscription',
      impl: 'cli',
      cli: process.execPath,
      args: [script, pidFile],
    });

    const p = strategy.call('prompt', { timeoutMs: 150 });
    await expect(p).rejects.toBeInstanceOf(CliTimeoutError);
    await expect(p).rejects.toThrow('timeout after 150ms');

    const pid = Number(await readFile(pidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});

describe('subscriptionCliStrategy output bound', () => {
  it('fails loud and reclaims a reviewer whose stdout exceeds the caller bound', async () => {
    const script = join(tmpRoot, 'large-output.js');
    await writeFile(script, `process.stdout.write('x'.repeat(4096));`, 'utf8');
    const strategy = subscriptionCliStrategy({
      mode: 'subscription',
      impl: 'cli',
      cli: process.execPath,
      args: [script],
    });

    await expect(
      strategy.call('prompt', { timeoutMs: 10_000, maxOutputBytes: 1024 }),
    ).rejects.toThrow('stdout exceeded 1024 bytes');
  });
});

describe('subscriptionCliStrategy subagent marker (SUB.1, wg-627effbb2c38)', () => {
  it('the spawned child sees OPENSQUID_SUBAGENT=1', async () => {
    const script = join(tmpRoot, 'echo-marker.js');
    await writeFile(
      script,
      'process.stdout.write(String(process.env.OPENSQUID_SUBAGENT));',
      'utf8',
    );
    const strategy = subscriptionCliStrategy({
      mode: 'subscription',
      impl: 'cli',
      cli: process.execPath,
      args: [script],
    });

    await expect(strategy.call('prompt', { timeoutMs: 10_000 })).resolves.toBe('1');
  });
});
