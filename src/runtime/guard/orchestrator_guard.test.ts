/**
 * GS1 — Orchestrator guard unit tests (CORRECTED: deny-list + agent_id executor exemption).
 *
 * The prior guard was reverted because it (1) over-denied via an allow-list (`isReadOnlyBash`
 * blocked git/pnpm/cd/compound commands) and (2) didn't exempt real executors. These tests pin
 * the corrected behavior: only CODE-EDITING is denied in the main loop, executors are exempt via
 * `agent_id`, and orchestration commands (git/pnpm/grep/cd) are allowed.
 */
import { describe, expect, it } from 'vitest';

import { checkOrchestratorGuard, isMutatingCall } from './orchestrator_guard.js';

describe('isMutatingCall — deny-list, default-allow', () => {
  // --- always-mutating tools ---
  it('Write is always mutating', () => {
    expect(isMutatingCall('Write', { file_path: '/tmp/x', content: 'y' })).toBe(true);
  });
  it('Edit is always mutating', () => {
    expect(isMutatingCall('Edit', { file_path: '/tmp/x', old_string: 'a', new_string: 'b' })).toBe(
      true,
    );
  });
  it('NotebookEdit is always mutating', () => {
    expect(isMutatingCall('NotebookEdit', {})).toBe(true);
  });

  // --- Bash deny-list patterns → mutating ---
  it('Bash `sed -i x` → mutating', () => {
    expect(isMutatingCall('Bash', { command: 'sed -i x' })).toBe(true);
  });
  it('Bash `echo x > f` → mutating (output redirect)', () => {
    expect(isMutatingCall('Bash', { command: 'echo x > f' })).toBe(true);
  });
  it('Bash `cmd >> log` → mutating (append redirect)', () => {
    expect(isMutatingCall('Bash', { command: 'cmd >> log' })).toBe(true);
  });
  it('Bash `... | tee file` → mutating', () => {
    expect(isMutatingCall('Bash', { command: 'echo x | tee file.txt' })).toBe(true);
  });
  it('Bash `cp a b` → mutating', () => {
    expect(isMutatingCall('Bash', { command: 'cp a b' })).toBe(true);
  });
  it('Bash `mv a b` → mutating', () => {
    expect(isMutatingCall('Bash', { command: 'mv a b' })).toBe(true);
  });

  // --- Bash default-allow (not on the deny-list) → NOT mutating ---
  it('Bash `git status` → NOT mutating', () => {
    expect(isMutatingCall('Bash', { command: 'git status' })).toBe(false);
  });
  it('Bash `pnpm test` → NOT mutating', () => {
    expect(isMutatingCall('Bash', { command: 'pnpm test' })).toBe(false);
  });
  it('Bash `cd a && grep b` → NOT mutating', () => {
    expect(isMutatingCall('Bash', { command: 'cd a && grep b' })).toBe(false);
  });
  it('Bash `vitest run` → NOT mutating', () => {
    expect(isMutatingCall('Bash', { command: 'vitest run src/' })).toBe(false);
  });
  it('Bash `node script.js` → NOT mutating', () => {
    expect(isMutatingCall('Bash', { command: 'node script.js' })).toBe(false);
  });
  it('Bash `git log 2>/dev/null` → NOT mutating (fd redirect is not a file write)', () => {
    expect(isMutatingCall('Bash', { command: 'git log 2>/dev/null' })).toBe(false);
  });
  it('Bash `cmd 2>&1` → NOT mutating (dup, not a file write)', () => {
    expect(isMutatingCall('Bash', { command: 'cmd 2>&1' })).toBe(false);
  });
  it('Bash with no command string → NOT mutating (fail-open)', () => {
    expect(isMutatingCall('Bash', {})).toBe(false);
  });

  // --- non-Bash orchestration tools → NOT mutating ---
  it('Read → NOT mutating', () => {
    expect(isMutatingCall('Read', { file_path: '/tmp/x' })).toBe(false);
  });
  it('Grep → NOT mutating', () => {
    expect(isMutatingCall('Grep', { pattern: 'foo' })).toBe(false);
  });
  it('Agent → NOT mutating', () => {
    expect(isMutatingCall('Agent', { description: 'do work', prompt: 'work' })).toBe(false);
  });
  it('Task → NOT mutating', () => {
    expect(isMutatingCall('Task', {})).toBe(false);
  });
  it('mcp__* tool → NOT mutating', () => {
    expect(isMutatingCall('mcp__opensquid__recall', { query: 'x' })).toBe(false);
  });
});

describe('checkOrchestratorGuard — main loop denies, executor exempt', () => {
  // --- main loop (no agent_id): CODE-EDITING is denied ---
  it('main (no agent_id) + Write → deny', () => {
    const r = checkOrchestratorGuard('Write', { file_path: '/tmp/x', content: 'y' });
    expect(r.deny).toBe(true);
    expect(r.message).toContain('orchestrator guard');
  });
  it('main + Edit → deny', () => {
    expect(checkOrchestratorGuard('Edit', { file_path: '/tmp/x' }).deny).toBe(true);
  });
  it('main + NotebookEdit → deny', () => {
    expect(checkOrchestratorGuard('NotebookEdit', {}).deny).toBe(true);
  });
  it('main + `sed -i x` → deny', () => {
    expect(checkOrchestratorGuard('Bash', { command: 'sed -i x' }).deny).toBe(true);
  });
  it('main + `echo x > f` → deny', () => {
    expect(checkOrchestratorGuard('Bash', { command: 'echo x > f' }).deny).toBe(true);
  });

  // --- main loop: orchestration commands are ALLOWED (the over-denial regression) ---
  it('main + `git status` → ALLOW', () => {
    expect(checkOrchestratorGuard('Bash', { command: 'git status' }).deny).toBe(false);
  });
  it('main + `pnpm test` → ALLOW', () => {
    expect(checkOrchestratorGuard('Bash', { command: 'pnpm test' }).deny).toBe(false);
  });
  it('main + `cd a && grep b` → ALLOW', () => {
    expect(checkOrchestratorGuard('Bash', { command: 'cd a && grep b' }).deny).toBe(false);
  });
  it('main + Read → ALLOW', () => {
    expect(checkOrchestratorGuard('Read', { file_path: '/tmp/x' }).deny).toBe(false);
  });
  it('main + Agent → ALLOW', () => {
    expect(checkOrchestratorGuard('Agent', { description: 'work', prompt: 'work' }).deny).toBe(
      false,
    );
  });

  // --- executor exemption: agent_id present → ALLOW even for mutating calls ---
  it('agent_id present + Write → ALLOW (executor exempt)', () => {
    const r = checkOrchestratorGuard(
      'Write',
      { file_path: '/tmp/x', content: 'y' },
      { agent_id: 'executor-abc123' },
    );
    expect(r.deny).toBe(false);
  });
  it('agent_id present + `sed -i` → ALLOW (executor exempt)', () => {
    const r = checkOrchestratorGuard(
      'Bash',
      { command: 'sed -i s/a/b/ file.ts' },
      { agent_id: 'executor-xyz' },
    );
    expect(r.deny).toBe(false);
  });
});
