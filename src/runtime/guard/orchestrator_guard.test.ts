/**
 * GS1 — Orchestrator guard unit tests (CORRECTED: deny-list + agent_id executor exemption).
 *
 * The prior guard was reverted because it (1) over-denied via an allow-list (`isReadOnlyBash`
 * blocked git/pnpm/cd/compound commands) and (2) didn't exempt real executors. These tests pin
 * the corrected behavior: only CODE-EDITING is denied in the main loop, executors are exempt via
 * `agent_id`, and orchestration commands (git/pnpm/grep/cd) are allowed.
 */
import { describe, expect, it } from 'vitest';

import {
  checkDesignDocRewrite,
  checkOrchestratorGuard,
  isCodeFileMutation,
  isDesignDoc,
  isDocumentPath,
  isMutatingCall,
} from './orchestrator_guard.js';

describe('isMutatingCall — deny-list, default-allow', () => {
  // --- always-mutating tools ---
  it('Write is always mutating', () => {
    expect(isMutatingCall('Write', { file_path: '/tmp/x', content: 'y' })).toBe(true);
  });
  it('Edit is always mutating', () => {
    expect(isMutatingCall('Edit', { file_path: '/tmp/x', old_string: 'a', new_string: 'b' })).toBe(
      true,
    );
    expect(
      isMutatingCall('MultiEdit', {
        file_path: '/tmp/x',
        edits: [{ old_string: 'a', new_string: 'b' }],
      }),
    ).toBe(true);
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
    expect(checkOrchestratorGuard('MultiEdit', { file_path: '/tmp/x' }).deny).toBe(true);
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

describe('isDocumentPath — the doc-only lane', () => {
  it('Markdown files are documents', () => {
    expect(isDocumentPath('docs/plan.md')).toBe(true);
    expect(isDocumentPath('/repo/README.md')).toBe(true);
    expect(isDocumentPath('notes.MDX')).toBe(true); // case-insensitive
  });
  it('anything under a docs/ directory is a document', () => {
    expect(isDocumentPath('docs/research/foo-pre-research.md')).toBe(true);
    expect(isDocumentPath('/repo/docs/diagram.svg')).toBe(true); // location, not extension
  });
  it('coding files are NOT documents', () => {
    expect(isDocumentPath('src/runtime/x.ts')).toBe(false);
    expect(isDocumentPath('/repo/packs/builtin/fullstack-flow/pack.yaml')).toBe(false);
    expect(isDocumentPath('package.json')).toBe(false);
    expect(isDocumentPath('/tmp/x')).toBe(false);
  });
});

describe('isCodeFileMutation — document writes are not coding-file mutations', () => {
  it('a document Write/Edit is NOT a coding-file mutation', () => {
    expect(isCodeFileMutation('Write', { file_path: 'docs/plan.md', content: 'x' })).toBe(false);
    expect(isCodeFileMutation('Edit', { file_path: '/repo/README.md' })).toBe(false);
    expect(isCodeFileMutation('MultiEdit', { file_path: '/repo/README.md' })).toBe(false);
  });
  it('a non-document Write/Edit IS a coding-file mutation', () => {
    expect(isCodeFileMutation('Write', { file_path: 'src/x.ts', content: 'x' })).toBe(true);
    expect(isCodeFileMutation('Edit', { file_path: 'packs/x/pack.yaml' })).toBe(true);
    expect(isCodeFileMutation('MultiEdit', { file_path: 'packs/x/pack.yaml' })).toBe(true);
  });
  it('a file-writing Bash is a coding-file mutation; a read is not', () => {
    expect(isCodeFileMutation('Bash', { command: 'echo x > f' })).toBe(true);
    expect(isCodeFileMutation('Bash', { command: 'git status' })).toBe(false);
    expect(isCodeFileMutation('Read', { file_path: 'src/x.ts' })).toBe(false);
  });
});

describe('checkOrchestratorGuard — documents pass, coding files gated by permission', () => {
  it('main + Write to a DOCUMENT → ALLOW (the doc-only lane)', () => {
    expect(checkOrchestratorGuard('Write', { file_path: 'docs/plan.md', content: 'x' }).deny).toBe(
      false,
    );
    expect(checkOrchestratorGuard('Edit', { file_path: '/repo/README.md' }).deny).toBe(false);
  });
  it('main + Write to a CODING FILE → DENY (freehand-blocked)', () => {
    const r = checkOrchestratorGuard('Write', { file_path: 'src/x.ts', content: 'x' });
    expect(r.deny).toBe(true);
    expect(r.message).toContain('DOCUMENTS only');
    expect(r.message).toContain('/code-write');
  });
  it('main + coding file WITH a standing permission grant → ALLOW', () => {
    const r = checkOrchestratorGuard('Write', { file_path: 'src/x.ts', content: 'x' }, undefined, {
      codeWritePermitted: true,
    });
    expect(r.deny).toBe(false);
  });
  it('main + coding file with permission NOT granted → DENY', () => {
    const r = checkOrchestratorGuard('Write', { file_path: 'src/x.ts', content: 'x' }, undefined, {
      codeWritePermitted: false,
    });
    expect(r.deny).toBe(true);
  });
  it('executor (agent_id) + coding file → ALLOW even without a grant (executors implement)', () => {
    const r = checkOrchestratorGuard(
      'Write',
      { file_path: 'src/x.ts', content: 'x' },
      { agent_id: 'executor-abc' },
    );
    expect(r.deny).toBe(false);
  });
});

describe('isDesignDoc — only a docs/design/*.md scope-of-record (AQG.5)', () => {
  it('matches a docs/design/ .md/.mdx path (relative or absolute)', () => {
    expect(isDesignDoc('docs/design/foo.md')).toBe(true);
    expect(isDesignDoc('/repo/docs/design/foo.mdx')).toBe(true);
  });
  it('does NOT match a task spec, a research doc, or a source file', () => {
    expect(isDesignDoc('docs/tasks/T-foo.md')).toBe(false);
    expect(isDesignDoc('docs/research/foo-pre-research-x.md')).toBe(false);
    expect(isDesignDoc('src/x.ts')).toBe(false);
    expect(isDesignDoc('docs/design/foo.ts')).toBe(false); // design dir but not a markdown doc
  });
});

describe('checkDesignDocRewrite — the interactive design-doc REWRITE gate (AQG.5)', () => {
  // A pure injected verdict reader; `throws` makes it reject (the fail-open branch).
  const gate = (
    verdict: string | undefined,
    opts: { hookInput?: { agent_id?: string }; throws?: boolean } = {},
    file_path = 'docs/design/x.md',
    tool = 'Write',
  ) =>
    checkDesignDocRewrite(tool, { file_path }, opts.hookInput, {
      readScopeVerdict: () =>
        opts.throws ? Promise.reject(new Error('unreadable')) : Promise.resolve(verdict),
    });

  it('present-and-not-GUESS_FREE (UNRESOLVED) rewrite → deny', async () => {
    expect((await gate('VERDICT: UNRESOLVED\n- a redundancy defect')).deny).toBe(true);
  });

  it('GUESS_FREE verdict → allow', async () => {
    expect((await gate('VERDICT: GUESS_FREE')).deny).toBe(false);
  });

  it('no cache (undefined — the first write) → allow (REWRITE-gate seeds the audit)', async () => {
    expect((await gate(undefined)).deny).toBe(false);
  });

  it('a throwing reader → allow (fail-open, never a hard stall)', async () => {
    expect((await gate(undefined, { throws: true })).deny).toBe(false);
  });

  it('executor (agent_id) → allow even on an UNRESOLVED verdict (exempt, as checkOrchestratorGuard)', async () => {
    expect((await gate('VERDICT: UNRESOLVED', { hookInput: { agent_id: 'a' } })).deny).toBe(false);
  });

  it('a non-design write (src/, docs/tasks/) → allow even on an UNRESOLVED verdict (only design docs gated)', async () => {
    expect((await gate('VERDICT: UNRESOLVED', {}, 'src/x.ts')).deny).toBe(false);
    expect((await gate('VERDICT: UNRESOLVED', {}, 'docs/tasks/T-x.md')).deny).toBe(false);
  });

  it('a non-Write/Edit tool on a design path → allow (only file writes are gated)', async () => {
    expect((await gate('VERDICT: UNRESOLVED', {}, 'docs/design/x.md', 'Read')).deny).toBe(false);
    expect((await gate('VERDICT: UNRESOLVED', {}, 'docs/design/x.md', 'MultiEdit')).deny).toBe(
      true,
    );
  });
});
