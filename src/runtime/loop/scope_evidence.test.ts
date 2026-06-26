/**
 * T2.4 — scopeEvidence tests (deterministic, zero LLM). Uses the vitest globalSetup OPENSQUID_HOME temp dir
 * (precedent: captured_ask.test.ts / fsm_state.test.ts) for session-state writes; artifacts go to an OS temp
 * dir. Unique sid per test.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendAsk } from '../coverage/captured_ask.js';
import { appendTool } from '../session_state.js';

import { scopeEvidence } from './scope_evidence.js';

let n = 0;
const sid = (): string => `scope-evidence-test-${String(n++)}`;

async function writeArtifact(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scope-evidence-'));
  const p = join(dir, 'art-pre-research.md');
  await writeFile(p, body, 'utf8');
  return p;
}

async function seedDepth(s: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await appendTool(s, 'Read');
}

describe('scopeEvidence (T2.4)', () => {
  it('resolving ask_span anchors → anchorsOk true', async () => {
    const s = sid();
    await appendAsk(s, 'add a login screen and keep me signed in');
    const p = await writeArtifact(
      [
        '1. Login form [ask: "add a login screen"]',
        '2. Session store [ask: "keep me signed in"]',
      ].join('\n'),
    );
    const ev = await scopeEvidence(s, p);
    expect(ev.anchorsOk).toBe(true);
  });

  it('an off-ask element → drift → anchorsOk false', async () => {
    const s = sid();
    await appendAsk(s, 'add a login screen');
    const p = await writeArtifact(
      [
        '1. Login form [ask: "add a login screen"]',
        '2. Telemetry dashboard [ask: "ship analytics"]',
      ].join('\n'),
    );
    const ev = await scopeEvidence(s, p);
    expect(ev.anchorsOk).toBe(false); // "ship analytics" is not a substring of the captured ask
  });

  it('missing artifact → fail-closed {false, 0, false}', async () => {
    const ev = await scopeEvidence(sid(), '/no/such/pre-research.md');
    expect(ev).toEqual({ anchorsOk: false, depth: 0, openQuestion: false });
  });

  it('depth is counted from the since_scope_start window (recall/Read/Grep)', async () => {
    const s = sid();
    await appendAsk(s, 'do the thing');
    await seedDepth(s, 3); // 3 Read calls
    await appendTool(s, 'Bash'); // not a research tool → not counted
    const p = await writeArtifact('1. Thing [ask: "do the thing"]');
    const ev = await scopeEvidence(s, p);
    expect(ev.depth).toBe(3);
  });

  it('an unchecked OPEN QUESTION line → openQuestion true', async () => {
    const s = sid();
    await appendAsk(s, 'do the thing');
    const p = await writeArtifact(
      ['1. Thing [ask: "do the thing"]', '', '- [ ] OPEN QUESTION: which backend?'].join('\n'),
    );
    const ev = await scopeEvidence(s, p);
    expect(ev.openQuestion).toBe(true);
  });

  it('a resolved (checked) open question does NOT trip openQuestion', async () => {
    const s = sid();
    await appendAsk(s, 'do the thing');
    const p = await writeArtifact(
      ['1. Thing [ask: "do the thing"]', '', '- [x] OPEN QUESTION: resolved'].join('\n'),
    );
    const ev = await scopeEvidence(s, p);
    expect(ev.openQuestion).toBe(false);
  });

  it('a fully-ready artifact → anchorsOk ∧ depth≥3 ∧ !openQuestion (the pass shape)', async () => {
    const s = sid();
    await appendAsk(s, 'add a login screen');
    await seedDepth(s, 3);
    const p = await writeArtifact('1. Login form [ask: "add a login screen"]');
    const ev = await scopeEvidence(s, p);
    expect(ev.anchorsOk && ev.depth >= 3 && !ev.openQuestion).toBe(true);
  });
});
