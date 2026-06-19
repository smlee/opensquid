/** T4 — startup-report persistence: write/read round-trip incl. recovery + startedAt. */
import { readFile, rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import type { StartupReport } from './reconcile.js';
import { readStartupReport, startupReportPath, writeStartupReport } from './startup_report_file.js';

const REPORT: StartupReport = {
  packs: { a: 'connected', b: { wedged: 'bad fsm' } },
  actors: { workspace: 'new_start', agent: 'resume' },
  failures: [{ actor: 'b', reason: 'bad fsm' }],
};

afterEach(async () => {
  await rm(startupReportPath(), { force: true });
});

describe('startup_report_file (T4)', () => {
  it('write → read round-trips, carrying recovery + startedAt', async () => {
    await writeStartupReport(REPORT, false, 1700);
    expect(await readStartupReport()).toEqual({ ...REPORT, recovery: false, startedAt: 1700 });
  });

  it('recovery:true persists', async () => {
    await writeStartupReport(REPORT, true, 1800);
    expect((await readStartupReport())?.recovery).toBe(true);
  });

  it('absent file → null (no report yet)', async () => {
    await rm(startupReportPath(), { force: true });
    expect(await readStartupReport()).toBeNull();
  });

  it('a corrupt file → null (fail-soft)', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(startupReportPath(), '{ not json');
    expect(await readStartupReport()).toBeNull();
  });

  it('overwrites on a second write (latest boot wins)', async () => {
    await writeStartupReport(REPORT, false, 1700);
    await writeStartupReport({ ...REPORT, packs: { a: 'connected' } }, false, 1900);
    const back = await readStartupReport();
    expect(back?.startedAt).toBe(1900);
    expect(Object.keys(back?.packs ?? {})).toEqual(['a']);
    // sanity: the file is valid JSON ending in a newline (atomic-write contract).
    expect((await readFile(startupReportPath(), 'utf8')).endsWith('}\n')).toBe(true);
  });
});
