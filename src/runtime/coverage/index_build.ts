/**
 * CFD.1 — the CodeIndex builder. The ONLY I/O in the coverage subsystem: it reads the gated `src/`/`packs/`
 * tree once and produces a pure `CodeIndex` (exports / modules / bindings / tests / importGraph) that the pure
 * `checkCoverage` consumes. Parsing is intentionally lightweight (regex over the TS source, not a full
 * type-checker) — the proof-test is the authority for dormancy (SPIKE-1), so the static index is an advisory
 * pre-filter and need not solve symbol-level call-graph.
 *
 * Spec: loop/docs/tasks/T-v2-coverage-foundation.md.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename, dirname, resolve } from 'node:path';

import type { CodeIndex } from './check.js';

/** Bare entrypoint name → its live hook file (design-grounded hooks). */
export const ENTRYPOINTS: Record<string, string> = {
  'pre-tool-use': 'src/runtime/hooks/pre-tool-use.ts',
  'post-tool-use': 'src/runtime/hooks/post-tool-use.ts',
  // Track 1 adds its terminal entrypoint when it grounds the wedge auto-wire requirement.
};

export interface SourceFile {
  path: string; // repo-relative, POSIX
  content: string;
}

/** Read the gated tree and build the index (I/O wrapper over the pure `indexFromFiles`). */
export function buildCodeIndex(repoRoot: string, gatedPrefixes: string[]): CodeIndex {
  const files: SourceFile[] = [];
  for (const prefix of gatedPrefixes) {
    for (const abs of walkTs(join(repoRoot, prefix))) {
      files.push({
        path: relative(repoRoot, abs).split('\\').join('/'),
        content: readFileSync(abs, 'utf8'),
      });
    }
  }
  return indexFromFiles(files);
}

/** PURE: build the CodeIndex from in-memory files (fixture-testable, no fs). */
export function indexFromFiles(files: SourceFile[]): CodeIndex {
  const exports: { name: string; file: string }[] = [];
  const modules: string[] = [];
  const bindings: Record<string, string[]> = {};
  const tests: Record<string, { activeCount: number }> = {};

  for (const f of files) {
    if (isTest(f.path)) {
      tests[f.path] = { activeCount: countActiveTests(f.content) };
      continue;
    }
    modules.push(basename(f.path).replace(/\.ts$/, ''));
    for (const name of exportedIdentifiers(f.content)) exports.push({ name, file: f.path });
    Object.assign(bindings, extractBindings(f.content));
  }

  return { exports, modules, bindings, tests, importGraph: buildImportGraph(files) };
}

const isTest = (p: string): boolean => p.endsWith('.test.ts');

function* walkTs(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // missing prefix dir → nothing
  }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const abs = join(dir, e);
    if (statSync(abs).isDirectory()) yield* walkTs(abs);
    else if (e.endsWith('.ts')) yield abs;
  }
}

/** Exact exported/declared identifiers (function/const/let/class/interface/type/enum). */
export function exportedIdentifiers(src: string): string[] {
  const re =
    /\bexport\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  const out = new Set<string>();
  for (const m of src.matchAll(re)) {
    const name = m[1];
    if (name !== undefined) out.add(name);
  }
  return [...out];
}

/** count of NON-skipped it()/test(). The `.skip`/`.todo` forms have a `.` after the name, so the `it(`/`test(`
 *  pattern already excludes them — no subtraction needed. */
export function countActiveTests(src: string): number {
  return (src.match(/\b(?:it|test)\s*\(/g) ?? []).length;
}

/**
 * For each `export function NAME`, the ctx keys it binds via `<map>.set('key', …)`. (Slice-1 scope: the
 * `.set(literal)` form, which is what `buildGuardCtx` uses.) Returns { fnName: [keys] }.
 */
export function extractBindings(src: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const starts: { name: string; idx: number }[] = [];
  for (const m of src.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/g)) {
    const name = m[1];
    if (name !== undefined) starts.push({ name, idx: m.index ?? 0 });
  }
  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i];
    if (cur === undefined) continue;
    const end = starts[i + 1]?.idx ?? src.length;
    const keys: string[] = [];
    for (const m of src.slice(cur.idx, end).matchAll(/\.set\(\s*['"]([^'"]+)['"]/g)) {
      if (m[1] !== undefined) keys.push(m[1]);
    }
    if (keys.length > 0) out[cur.name] = [...new Set(keys)];
  }
  return out;
}

/** A minimal import-graph: reaches(from, symbol) = is `symbol`'s defining file transitively imported from any
 *  resolved `from` entrypoint? (advisory pre-filter; the proof-test is the authority). */
function buildImportGraph(files: SourceFile[]): {
  reaches(from: string[], symbol: string): boolean;
} {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const fileOfSymbol = new Map<string, string>();
  for (const f of files) {
    if (isTest(f.path)) continue;
    for (const name of exportedIdentifiers(f.content))
      if (!fileOfSymbol.has(name)) fileOfSymbol.set(name, f.path);
  }
  const importsOf = (f: SourceFile): string[] => {
    const out: string[] = [];
    for (const m of f.content.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec === undefined) continue;
      const cand = `${resolve('/', dirname(f.path), spec.replace(/\.js$/, '')).slice(1)}.ts`;
      if (byPath.has(cand)) out.push(cand);
    }
    return out;
  };
  return {
    reaches(from: string[], symbol: string): boolean {
      const target = fileOfSymbol.get(symbol);
      if (target === undefined) return false;
      const seeds = from
        .map((n) => ENTRYPOINTS[n])
        .filter((p): p is string => p !== undefined && byPath.has(p));
      const seen = new Set<string>(seeds);
      const queue = [...seeds];
      while (queue.length > 0) {
        const cur = queue.shift();
        if (cur === undefined) break;
        if (cur === target) return true;
        const f = byPath.get(cur);
        if (f === undefined) continue;
        for (const next of importsOf(f)) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return seen.has(target);
    },
  };
}
