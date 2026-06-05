/**
 * Tests for `check_flow_health` (T-FLOW-UNSKIPPABLE FU.3 / D3) — SessionStart
 * health assurance. The hooks-wired branch is isolated via CLAUDE_CONFIG_DIR.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckFlowHealth } from './check_flow_health.js';

// A minimal EvalCtx — check_flow_health only reads ctx.sessionId.
const ctx = { sessionId: 'cfh-test', event: { kind: 'session_start' as const } } as never;

const WIRED = {
  hooks: {
    PreToolUse: [{ hooks: [{ type: 'command', command: 'opensquid-hook-pretooluse' }] }],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: 'opensquid-hook-userpromptsubmit' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'opensquid-hook-stop' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'opensquid-hook-sessionstart' }] }],
  },
};

describe('check_flow_health (FU.3)', () => {
  let configDir: string;
  let prior: string | undefined;

  beforeEach(async () => {
    prior = process.env.CLAUDE_CONFIG_DIR;
    configDir = await mkdtemp(join(tmpdir(), 'cfh-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
    await rm(configDir, { recursive: true, force: true });
  });

  it('all opensquid hooks wired → no hook complaint (silent on the hooks dimension)', async () => {
    await writeFile(join(configDir, 'settings.json'), JSON.stringify(WIRED), 'utf8');
    const r = await CheckFlowHealth.execute({}, ctx);
    // A gate pack (coding-flow) loads from the builtin tree in-process, so the
    // result is healthy → null; if it ever surfaces, it must NOT mention hooks.
    if (r.ok && r.value !== null) {
      expect(r.value.content).not.toMatch(/hooks are NOT wired/);
    } else {
      expect(r.ok && r.value).toBeNull();
    }
  });

  it('opensquid hooks missing → loud inject_context naming the missing events', async () => {
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'some-other-hook' }] }] } }),
      'utf8',
    );
    const r = await CheckFlowHealth.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toBeNull();
      expect(r.value?.content).toMatch(/FLOW ENFORCEMENT IS NOT ACTIVE/);
      expect(r.value?.content).toMatch(/NOT wired/);
      expect(r.value?.content).toMatch(/RESTART this session/);
    }
  });

  it('no settings.json → fail-soft, reports it could not verify (never throws)', async () => {
    // no file written
    const r = await CheckFlowHealth.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value?.content).toMatch(/could not read .*settings\.json/);
    }
  });
});
