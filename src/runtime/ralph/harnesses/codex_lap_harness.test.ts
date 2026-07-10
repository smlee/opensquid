/**
 * MHL.8 — the Codex adapter over a FAKE JSONL fixture in the LIVE-confirmed codex-cli 0.144.0 shape
 * (T-multi-harness-lap): the flag array (defaults + config-driven), stdin delivery, the fail-loud auth
 * preflight, and the JSONL fold (agent_message concat, turn.completed.usage tokens, notional-0 cost, error/
 * empty/malformed-line handling). NO real `codex` here — the only real-binary test is the opt-in live smoke.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { codexLapHarness } from './codex_lap_harness.js';
import { outcomeFromEnvelope } from '../lap_outcome.js';

/** Build a fake `codex exec --json` JSONL stream in the verified 0.144.0 shape. */
const jsonl = (message: string, usage = { input_tokens: 12315, output_tokens: 19 }): string =>
  [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: message },
    }),
    JSON.stringify({ type: 'turn.completed', usage }),
  ].join('\n');

describe('codexLapHarness.spawnArgs + deliverPrompt (MHL.5)', () => {
  it('defaults: workspace-write / approval never / stdin prompt', () => {
    expect(codexLapHarness.spawnArgs({ maxBudgetUsd: 10 })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy=never',
      '-',
    ]);
  });

  it('config-driven sandbox + approval flow into the flags (never --dangerously-bypass-*)', () => {
    const args = codexLapHarness.spawnArgs({
      maxBudgetUsd: 10,
      sandbox: 'read-only',
      askForApproval: 'on-failure',
    });
    expect(args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy=on-failure',
      '-',
    ]);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('deliverPrompt sends the prompt via stdin (parity with Claude)', () => {
    expect(codexLapHarness.deliverPrompt('X')).toEqual({ stdin: 'X' });
  });
});

describe('codexLapHarness.preflight (fail-loud auth diagnostics, MHL.5)', () => {
  // Hermetic: drive the real preflight via a temp HOME (os.homedir() reads process.env.HOME on POSIX) + the
  // real env keys, save/restore both — no builtin mocking (node:fs/os named imports can't be redefined).
  const saved = {
    codex: process.env.CODEX_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    home: process.env.HOME,
  };
  let tmp: string;
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      const key = k === 'codex' ? 'CODEX_API_KEY' : k === 'openai' ? 'OPENAI_API_KEY' : 'HOME';
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('passes when CODEX_API_KEY is present', () => {
    process.env.CODEX_API_KEY = 'sk-test';
    delete process.env.OPENAI_API_KEY;
    expect(() => codexLapHarness.preflight?.({ maxBudgetUsd: 10 })).not.toThrow();
  });

  it('throws fail-loud when no env key and no ~/.codex/auth.json', () => {
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    tmp = mkdtempSync(join(tmpdir(), 'codex-noauth-')); // an empty HOME → no ~/.codex/auth.json
    process.env.HOME = tmp;
    expect(() => codexLapHarness.preflight?.({ maxBudgetUsd: 10 })).toThrow(/Codex auth not found/);
  });

  it('passes when ~/.codex/auth.json exists even without an env key', () => {
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    tmp = mkdtempSync(join(tmpdir(), 'codex-auth-'));
    mkdirSync(join(tmp, '.codex'));
    writeFileSync(join(tmp, '.codex', 'auth.json'), '{}');
    process.env.HOME = tmp;
    expect(() => codexLapHarness.preflight?.({ maxBudgetUsd: 10 })).not.toThrow();
  });
});

describe('codexLapHarness.parseEnvelope — the JSONL fold (MHL.5)', () => {
  it('folds the live shape → SHIPPED via extractTypedExit + real tokens + notional-0 cost', () => {
    const env = codexLapHarness.parseEnvelope(
      jsonl('done\nRALPH-EXIT: {"kind":"SHIPPED","stage":"code"}'),
      '',
    );
    expect(env).toMatchObject({ costUsd: 0, inputTokens: 12315, outputTokens: 19, isError: false });
    expect(env.resultText).toContain('RALPH-EXIT');
    expect(outcomeFromEnvelope(env).outcome).toEqual({ kind: 'SHIPPED', stage: 'code' });
  });

  it('concatenates multiple agent_message texts in stream order', () => {
    const stream = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'second' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }),
    ].join('\n');
    expect(codexLapHarness.parseEnvelope(stream, '').resultText).toBe('first\nsecond');
  });

  it('a WEDGE-tagged message → WEDGE through the fold', () => {
    const env = codexLapHarness.parseEnvelope(jsonl('RALPH-EXIT: {"kind":"WEDGE"}'), '');
    expect(outcomeFromEnvelope(env).outcome).toEqual({ kind: 'WEDGE' });
  });

  it('an error event → isError', () => {
    expect(
      codexLapHarness.parseEnvelope(JSON.stringify({ type: 'error', message: 'boom' }), '').isError,
    ).toBe(true);
    expect(codexLapHarness.parseEnvelope(JSON.stringify({ type: 'turn.failed' }), '').isError).toBe(
      true,
    );
  });

  it('an empty/whitespace stream → isError (no turn.completed)', () => {
    expect(codexLapHarness.parseEnvelope('', '').isError).toBe(true);
    expect(codexLapHarness.parseEnvelope('\n  \n', '').isError).toBe(true);
  });

  it('FCE.2: a refusal message with NO turn.completed → isError → CRASH (not SHIPPED)', () => {
    const stdout = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: "I can't access the workgraph" },
    });
    const env = codexLapHarness.parseEnvelope(stdout, '');
    expect(env.isError).toBe(true);
    expect(env.resultText).toContain("I can't access");
    expect(outcomeFromEnvelope(env).outcome).toEqual({ kind: 'CRASH' });
  });

  it('FCE.1: a completed turn with NO tag → not-errored, but CRASH via the fail-closed fold', () => {
    const env = codexLapHarness.parseEnvelope(jsonl('all done, everything looks good'), '');
    expect(env.isError).toBe(false);
    expect(outcomeFromEnvelope(env).outcome).toEqual({ kind: 'CRASH' });
  });

  it('a malformed line interleaved with valid events is skipped, not fatal', () => {
    const stream = [
      '{ not json',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
      'garbage}}}',
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 6 } }),
    ].join('\n');
    const env = codexLapHarness.parseEnvelope(stream, '');
    expect(env).toMatchObject({
      resultText: 'ok',
      inputTokens: 5,
      outputTokens: 6,
      isError: false,
    });
  });
});
