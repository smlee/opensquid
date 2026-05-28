/**
 * T-WAB5C WAB5C.2 — architectural-invariant regression net.
 *
 * Walks `src/` via the TypeScript compiler API and asserts that
 * `SessionManager.appendTurn` has exactly ONE production call site —
 * the ChatDispatcher in `runtime/agent_bridge/dispatcher.ts`.
 *
 * Why a test (not just a comment): the "dispatcher is the sole caller"
 * claim is load-bearing for `session_manager.ts`'s Concurrency contract.
 * A future commit that adds a second caller bypasses the dispatcher's
 * per-session mutex+queue policy and silently violates the contract.
 * This test catches that drift at PR review time.
 *
 * Why AST (not regex): regex over source matches `appendTurn` references
 * inside JSDoc comments (fragile + false-positive prone). The TS compiler
 * API parses the real call graph and emits no comment nodes by default —
 * the result is exact.
 *
 * Failure mode: if you legitimately need a new caller, route it through
 * `ChatDispatcher` or carry the mutex policy into the new layer; do NOT
 * relax this test without re-reading the WAB.5 contract.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/** Resolve `src/` from this test file's URL: ../../ ascends two levels. */
const SRC_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Recursively list every .ts file under `dir`, excluding tests + .d.ts. */
async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listSourceFiles(full)));
    } else if (
      e.isFile() &&
      e.name.endsWith('.ts') &&
      !e.name.endsWith('.test.ts') &&
      !e.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

interface CallSite {
  file: string;
  /** 1-indexed line number (matches editor display). */
  line: number;
}

/** Walk the AST collecting every `<expr>.appendTurn(...)` call site. */
function findAppendTurnCallSites(file: string, source: string): CallSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const sites: CallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      node.expression.name.text === 'appendTurn'
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      sites.push({ file, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

describe('T-WAB5C WAB5C.2 — appendTurn single-caller invariant', () => {
  it('appendTurn has exactly ONE production call site, and it is dispatcher.ts', async () => {
    const files = await listSourceFiles(SRC_ROOT);
    const allSites: CallSite[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      allSites.push(...findAppendTurnCallSites(file, source));
    }
    const display = allSites.map((s) => `${relative(SRC_ROOT, s.file)}:${s.line}`);

    expect(
      display,
      `appendTurn must have exactly ONE production call site in src/ (the ChatDispatcher).\n` +
        `Found ${String(display.length)} site(s):\n${display.map((d) => '  - ' + d).join('\n')}\n` +
        `If you added a new caller, route it through ChatDispatcher (which owns the\n` +
        `per-session mutex+queue policy) instead of calling appendTurn directly.`,
    ).toHaveLength(1);

    // Anchor the canonical location — if dispatcher.ts gets renamed or the
    // call moves to a different module, surface that explicitly.
    expect(
      display[0],
      `Expected the sole appendTurn caller to be runtime/agent_bridge/dispatcher.ts, ` +
        `got: ${display[0] ?? '<none>'}`,
    ).toMatch(/^runtime\/agent_bridge\/dispatcher\.ts:\d+$/);
  });
});
