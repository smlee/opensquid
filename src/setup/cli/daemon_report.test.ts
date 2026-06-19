/** T4 — `daemon report`: render + --show filter + freshness label + no-mutation (READ-ONLY). */
import { readFile, rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import type { StartupReport } from '../../runtime/genesis/reconcile.js';
import {
  startupReportPath,
  writeStartupReport,
} from '../../runtime/genesis/startup_report_file.js';
import { parseShow, runDaemonReport } from './daemon_report.js';

const REPORT: StartupReport = {
  packs: { a: 'connected', b: { wedged: 'bad fsm' }, c: { disabled: 'off by policy' } },
  actors: { workspace: 'new_start', agent: 'resume' },
  failures: [],
};
const stopped = { running: () => Promise.resolve(false) };
const live = { running: () => Promise.resolve(true) };

afterEach(async () => {
  await rm(startupReportPath(), { force: true });
});

describe('parseShow (T4)', () => {
  it('maps the flag values', () => {
    expect(parseShow(undefined)).toBe('failed');
    expect(parseShow('failed')).toBe('failed');
    expect(parseShow('all')).toBe('all');
    expect(parseShow('connected')).toBe('connected');
    expect(parseShow('b, c')).toEqual({ packs: ['b', 'c'] });
  });
});

describe('runDaemonReport (T4)', () => {
  it('no report file → a clear "not started" message', async () => {
    await rm(startupReportPath(), { force: true });
    expect(await runDaemonReport({}, stopped)).toMatch(/no genesis report yet/);
  });

  it('--show failed (default) lists the off packs WITH reason, omits connected', async () => {
    await writeStartupReport(REPORT, false, 1700);
    const out = await runDaemonReport({}, stopped);
    expect(out).toContain('✗ b: bad fsm');
    expect(out).toContain('✗ c: off by policy');
    expect(out).not.toContain('✓ a');
  });

  it('--show connected lists only connected; --show all lists everything', async () => {
    await writeStartupReport(REPORT, false, 1700);
    expect(await runDaemonReport({ show: 'connected' }, stopped)).toContain('✓ a');
    expect(await runDaemonReport({ show: 'connected' }, stopped)).not.toContain('✗ b');
    const all = await runDaemonReport({ show: 'all' }, stopped);
    expect(all).toContain('✓ a');
    expect(all).toContain('✗ b: bad fsm');
  });

  it('--show <pack…> filters to the named packs', async () => {
    await writeStartupReport(REPORT, false, 1700);
    const out = await runDaemonReport({ show: { packs: ['b'] } }, stopped);
    expect(out).toContain('✗ b: bad fsm');
    expect(out).not.toContain('c:');
  });

  it('ALWAYS shows the actors section + the boot timestamp', async () => {
    await writeStartupReport(REPORT, false, Date.parse('2026-06-19T12:00:00.000Z'));
    const out = await runDaemonReport({}, stopped);
    expect(out).toContain('actors:');
    expect(out).toContain('workspace: new_start');
    expect(out).toContain('booted 2026-06-19T12:00:00.000Z');
  });

  it('labels freshness via the injected running oracle (current vs last boot)', async () => {
    await writeStartupReport(REPORT, false, 1700);
    expect(await runDaemonReport({}, live)).toContain('current boot');
    expect(await runDaemonReport({}, stopped)).toContain('last boot — daemon not running');
  });

  it('surfaces the crash-recovery flag', async () => {
    await writeStartupReport(REPORT, true, 1700);
    expect(await runDaemonReport({}, stopped)).toContain('crash recovery');
  });

  it('--json emits the raw persisted report', async () => {
    await writeStartupReport(REPORT, false, 1700);
    const out = await runDaemonReport({ json: true }, stopped);
    expect(JSON.parse(out)).toEqual({ ...REPORT, recovery: false, startedAt: 1700 });
  });

  it('is READ-ONLY: a render run leaves the report file byte-identical', async () => {
    await writeStartupReport(REPORT, false, 1700);
    const before = await readFile(startupReportPath(), 'utf8');
    await runDaemonReport({ show: 'all' }, stopped);
    expect(await readFile(startupReportPath(), 'utf8')).toBe(before);
  });
});
