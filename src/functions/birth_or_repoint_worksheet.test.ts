/** T-scope-worksheet — birth_or_repoint_worksheet: NEW TRACK births a single + repoints; INTER-SCOPE keeps an in-flight batch. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Event } from '../runtime/event.js';
import { readSessionStateValue, writeSessionStateValue } from '../runtime/session_state.js';
import { parseWorksheet, worksheetPath, writeWorksheetFile } from '../runtime/worksheet/parse.js';
import { workGraphStore } from '../workgraph/store.js';
import { registerBirthOrRepointWorksheetFunction } from './birth_or_repoint_worksheet.js';
import { FunctionRegistry } from './registry.js';
import type { EvalCtx } from './registry.js';

const SID = 'birth-test';
const KEY = 'coding-flow-worksheet-path';
const event: Event = { kind: 'tool_call', tool: 'Write', args: {}, cwd: '/x' };
const ctx: EvalCtx = { event, bindings: new Map(), sessionId: SID, packId: 'coding-flow' };

let home: string;
const saved = process.env.OPENSQUID_HOME;

async function birth(filePath: string, effective = ''): Promise<void> {
  const reg = new FunctionRegistry();
  registerBirthOrRepointWorksheetFunction(reg);
  const def = reg.get('birth_or_repoint_worksheet');
  if (def === undefined) throw new Error('not registered');
  const r = await def.execute({ file_path: filePath, effective }, ctx);
  if (!r.ok) throw new Error('execute failed');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'opensquid-birth-'));
  process.env.OPENSQUID_HOME = home;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = saved;
  await rm(home, { recursive: true, force: true });
});

describe('birth_or_repoint_worksheet', () => {
  it('NEW TRACK (no path set) → births a valid single worksheet + repoints the path key', async () => {
    await birth('docs/research/T-bar-pre-research-2026-06-20.md', '# Bar Title\n');
    const path = (await readSessionStateValue(SID, KEY)) as string;
    expect(path).toBe(worksheetPath('T-bar'));
    const ws = parseWorksheet(path);
    expect('error' in ws).toBe(false);
    if (!('error' in ws)) {
      expect(ws.mode).toBe('single');
      expect(ws.scopes[0]?.id).toBe('T-bar');
      expect(ws.scopes[0]?.summary).toBe('Bar Title');
    }
  });

  it('repoints away from a STALE prior single path (no leak into a new track)', async () => {
    const stale = writeWorksheetFile('T-old', {
      mode: 'single',
      scopes: [{ id: 'T-old', summary: 's' }],
      order: ['T-old'],
    });
    await writeSessionStateValue(SID, KEY, stale);
    await birth('docs/research/T-new-pre-research-2026-06-20.md');
    expect(await readSessionStateValue(SID, KEY)).toBe(worksheetPath('T-new'));
  });

  it('INTER-SCOPE: an in-flight batch containing this scope → keeps the batch path', async () => {
    const wg = workGraphStore({
      dbUrl: `file:${join(home, 'workgraph.db')}`,
      sourceDir: join(home, 'store', 'issues'),
    });
    await wg.init();
    const a = await wg.createIssue({ title: 'scope a' }); // both left OPEN → batch in-flight
    const b = await wg.createIssue({ title: 'scope b' });
    const batch = writeWorksheetFile('T-batch', {
      mode: 'batch',
      scopes: [
        { id: 'T-a', issue: a.id, summary: 'sa' },
        { id: 'T-b', issue: b.id, summary: 'sb' },
      ],
      order: ['T-a', 'T-b'],
    });
    await writeSessionStateValue(SID, KEY, batch);
    await birth('docs/research/T-a-pre-research-2026-06-20.md');
    expect(await readSessionStateValue(SID, KEY)).toBe(batch); // unchanged: kept the in-flight batch
  });
});
