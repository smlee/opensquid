/**
 * RES-1 RUST `loop-engine` retirement — completeness + live-proof suite.
 *
 * Three binding checks (per T-loop-engine-rust-retirement LER.5):
 *   1. grep-COMPLETENESS — every `loop-engine` occurrence in `src/` is a §3 KEEP
 *      category (the `case 'loop-engine':` degradation guard + `pickDefaultKind`
 *      retired-tense comment, the `channels/routing*` git-REPO umbrella, the
 *      `portability.ts` exclude filter, the freshness test fixtures, and the
 *      already-retired-tense `index.ts`/`channels/config.ts`/`config.test.ts`
 *      headers) — NO present-tense live claim, and NO live reader of the dead
 *      Rust symbols (`resolveEngineBin`/`engine_bin`/`engine-config`/`../engine/config`).
 *   2. RAG RESOLVES libSQL (the retirement live-proof) — `resolveBackendConfig()`
 *      returns libSQL for {no config, stale `loop-engine` pin → degrades}.
 *   3. ZERO current-ralph-loop symbols changed — realized as a git-diff boundary
 *      check in the CODE-lap verification (see the block comment below); a RAG
 *      test does NOT import orchestrator internals (that would itself cross the
 *      §0 boundary).
 *
 * `resolveBackendConfig` is ASYNC (`config.ts:61`, `Promise<BackendConfig>`) — the
 * resolution-matrix callbacks MUST `await` it, matching the sibling `config.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveBackendConfig } from './config.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // src/

// The §3 KEEP allowlist: every legitimate `loop-engine` occurrence, file-anchored
// (src-relative). A hit NOT in this set = an un-retired present-tense claim (the
// assertion fails naming the offender).
const KEEP = new Set<string>([
  'rag/config.ts', // "Accepts:" env value + the case-guard + pickDefaultKind retired-tense
  'rag/config.test.ts', // already-retired-tense header + degradation assertions
  'channels/routing.ts', // loop-engine git-REPO umbrella member
  'channels/routing.test.ts', // umbrella routing fixtures
  'channels/config.ts', // ":29 subsystem has since been retired" (already correct)
  'index.ts', // ":4 subsystem was retired; fully engine-free" (already correct)
  'setup/cli/portability.ts', // ":58 /^loop-engine\\./ exclude filter"
  'runtime/hooks/freshness-skill.integration.test.ts', // test fixture strings
  'rag/loop_engine_retirement.test.ts', // THIS file (names the KEEP strings) — self-exclude
]);

/** `grep -rl <pat> SRC` → src-relative file paths (never throws on zero hits). */
function grepFiles(pattern: string): string[] {
  try {
    return execFileSync('grep', ['-rl', pattern, SRC], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((p) => p.slice(SRC.length + 1));
  } catch {
    return []; // grep exits 1 on no match
  }
}

describe('RES-1 loop-engine (Rust) retirement — completeness', () => {
  it('every `loop-engine` occurrence in src/ is a KEEP category (no present-tense live claim)', () => {
    const offenders = grepFiles('loop-engine').filter((f) => !KEEP.has(f));
    expect(offenders, `un-retired loop-engine claims: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no live reader of the dead Rust symbols in src/', () => {
    // A live def/reader would be an engine-path import, a call to the removed
    // resolver, or an engine_bin type field. Bare mentions inside THIS test's
    // own pattern array are not live refs (they fail the predicate below).
    for (const sym of ['resolveEngineBin', 'engine_bin', 'engine-config', '\\.\\./engine/config']) {
      const out = (() => {
        try {
          return execFileSync('grep', ['-rnE', sym, SRC], { encoding: 'utf8' });
        } catch {
          return '';
        }
      })();
      const live = out
        .split('\n')
        .filter(Boolean)
        .filter((l) => /import .*\/engine\/|resolveEngineBin\s*\(|:\s*engine_bin\b/.test(l));
      expect(live, `live dead-symbol reference for ${sym}: ${live.join(' | ')}`).toEqual([]);
    }
  });
});

describe('RES-1 loop-engine retirement — RAG resolves libSQL (retirement live-proof)', () => {
  const prev = process.env.OPENSQUID_RAG_BACKEND;
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENSQUID_RAG_BACKEND;
    else process.env.OPENSQUID_RAG_BACKEND = prev;
  });

  it('no env → libsql-fastembed default (pickDefaultKind, engine-free)', async () => {
    delete process.env.OPENSQUID_RAG_BACKEND;
    expect((await resolveBackendConfig()).kind).toBe('libsql-fastembed');
  });

  it('a stale `loop-engine` pin degrades to libsql-fastembed (the case-guard)', async () => {
    process.env.OPENSQUID_RAG_BACKEND = 'loop-engine';
    // never throws; never returns `loop-engine`
    expect((await resolveBackendConfig()).kind).toBe('libsql-fastembed');
  });
});

/*
 * Assertion 3 — ZERO current-ralph-loop symbols changed (the §0 boundary guard),
 * realized as a git-diff name-only check in the CODE-lap verification rather than a
 * runtime import (importing orchestrator internals into a RAG test would itself cross
 * the boundary). The retirement diff must touch NO current-loop path/symbol:
 *
 *   git diff --name-only <base>..HEAD \
 *     | grep -E 'loop_(events|metrics|state|stage|status|autospawn)|orchestrator\.ts|ralph\.ts|loop\.pid|loop\.spawn\.lock'
 *   # → MUST be empty
 */
