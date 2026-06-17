/**
 * PATH.1 (wg-61fe416b3006) — the single-resolver guarantee.
 *
 * 1. `opensquidHomeFrom`/`OPENSQUID_HOME` unit: env override + empty/whitespace →
 *    default + the `process.env` reader.
 * 2. Grep-guard regression firewall: NO non-test source outside `paths.ts` may
 *    reimplement `join(homedir(), '.opensquid')`. This is what keeps PATH.1 done —
 *    a reimpl creeping back fails this test (mirrors the spec-citation guard).
 */
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { OPENSQUID_HOME, opensquidHomeFrom } from './paths.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_HOME = join(homedir(), '.opensquid');

describe('opensquidHomeFrom / OPENSQUID_HOME (PATH.1 single resolver)', () => {
  it('returns the OPENSQUID_HOME override when set', () => {
    expect(opensquidHomeFrom({ OPENSQUID_HOME: '/tmp/oshome' } as NodeJS.ProcessEnv)).toBe(
      '/tmp/oshome',
    );
  });
  it('treats empty / whitespace OPENSQUID_HOME as unset (→ ~/.opensquid)', () => {
    expect(opensquidHomeFrom({ OPENSQUID_HOME: '   ' } as NodeJS.ProcessEnv)).toBe(DEFAULT_HOME);
    expect(opensquidHomeFrom({ OPENSQUID_HOME: '' } as NodeJS.ProcessEnv)).toBe(DEFAULT_HOME);
  });
  it('defaults to ~/.opensquid when unset', () => {
    expect(opensquidHomeFrom({} as NodeJS.ProcessEnv)).toBe(DEFAULT_HOME);
  });
  it('OPENSQUID_HOME() resolves against process.env', () => {
    const prior = process.env.OPENSQUID_HOME;
    process.env.OPENSQUID_HOME = '/tmp/proc-home';
    try {
      expect(OPENSQUID_HOME()).toBe('/tmp/proc-home');
    } finally {
      if (prior === undefined) delete process.env.OPENSQUID_HOME;
      else process.env.OPENSQUID_HOME = prior;
    }
  });
});

describe('single-resolver grep guard (PATH.1 regression firewall)', () => {
  it('no non-test source outside paths.ts reimplements join(homedir(), ".opensquid")', () => {
    const out = execSync(
      `grep -rno "homedir(), '.opensquid'" src --include='*.ts' --exclude='*.test.ts' | grep -v 'src/runtime/paths.ts' || true`,
      { cwd: REPO, encoding: 'utf8' },
    );
    expect(out.trim()).toBe('');
  });
});
