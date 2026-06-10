/**
 * subscriptionCliStrategy — timeout contract (T-AUDIT-SPAWN-FIX).
 *
 * The timeout rejection must be the TYPED `CliTimeoutError` (callers like
 * cached_audit's spawn ledger classify by type), with the message text
 * byte-identical to the historical `timeout after Xms` string.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  it('rejects with CliTimeoutError (typed) and the historical message text', async () => {
    // A child that never reads stdin to completion and never exits.
    const script = join(tmpRoot, 'hang.js');
    await writeFile(script, 'setInterval(() => {}, 1000);', 'utf8');
    const strategy = subscriptionCliStrategy({
      mode: 'subscription',
      impl: 'cli',
      cli: process.execPath,
      args: [script],
    });

    const p = strategy.call('prompt', { timeoutMs: 150 });
    await expect(p).rejects.toBeInstanceOf(CliTimeoutError);
    await expect(p).rejects.toThrow('timeout after 150ms');
  });
});
