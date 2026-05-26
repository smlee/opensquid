/**
 * Tests for the H.3 worked-example skills under `packs/builtin/examples/`.
 *
 * Three concerns covered, each as its own describe block:
 *
 *   1. **Pack load** — every example directory loads cleanly via
 *      `loadPack()`. The H.2 Zod refinement runs `parseExpression` on
 *      every `if:` clause at load time, so a clean load proves every
 *      clause in every example is grammar-valid.
 *
 *   2. **Fixture evaluation** — every `fixtures/*.input.json` ships with
 *      a matching `*.expected.json`. The input carries an `if:` clause
 *      and a `bindings` map; the expected carries the `verdict` boolean.
 *      We feed (clause, bindings) through `evalCondition` and assert the
 *      result matches `verdict`.
 *
 *   3. **Grammar-guide doc samples parse** — extract every fenced ```yaml`
 *      code block from `docs/skill-grammar-guide.md`, find every `if:`
 *      clause inside, and feed each one through `parseExpression()`. A
 *      sample that became invalid (e.g. a future operator change broke
 *      grammar compatibility) would fail here before the change shipped.
 *
 * Lives under `test/` so vitest discovers it (vitest.config.ts pattern is
 * `src/**\/*.test.ts`, `test/**\/*.test.ts`, `scripts/**\/*.test.ts`). The
 * task's verification command says
 * `pnpm vitest run packs/builtin/examples/` but vitest's discovery does
 * not walk packs/; the actual test file lives here and is part of the
 * default `pnpm test` run.
 */

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../src/packs/loader.js';
import { evalCondition, parseExpression } from '../src/runtime/evaluator/expression/index.js';

const EXAMPLES_ROOT = resolve('packs/builtin/examples');
const EXAMPLE_NAMES = [
  'multi-clause-drift-detector',
  'file-pattern-guard',
  'tool-history-correlator',
] as const;
const GRAMMAR_GUIDE = resolve('docs/skill-grammar-guide.md');

interface FixtureInput {
  if: string;
  bindings: Record<string, unknown>;
}
interface FixtureExpected {
  verdict: boolean;
}

function toBindingMap(obj: Record<string, unknown>): Map<string, unknown> {
  return new Map(Object.entries(obj));
}

/**
 * Strip a trailing YAML comment from a clause line, respecting single
 * and double quotes. A `#` inside a quoted segment is part of the
 * expression; a `#` after the outermost quotes close (preceded by
 * whitespace) starts a comment that runs to end-of-line.
 */
function stripTrailingYamlComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble) {
      // A comment must be preceded by whitespace (or start-of-line) to
      // count — otherwise `#` inside a regex like `match(x, "a#b")`
      // would falsely trigger.
      if (i === 0 || /\s/.test(s[i - 1]!)) {
        return s.slice(0, i).trimEnd();
      }
    }
  }
  return s;
}

describe('H.3 example skills — pack load', () => {
  for (const name of EXAMPLE_NAMES) {
    it(`${name} loads cleanly via loadPack`, async () => {
      const pack = await loadPack(join(EXAMPLES_ROOT, name));
      expect(pack.name).toBe(name);
      expect(pack.scope).toBe('universal');
      // Each example ships exactly one skill — the structural rule that
      // demonstrates the grammar feature.
      expect(pack.skills.length).toBe(1);
      const skill = pack.skills[0]!;
      // Each skill ships exactly one rule, with at least one process step
      // ending in a verdict.
      expect(skill.rules.length).toBe(1);
      const rule = skill.rules[0]!;
      if (rule.kind !== 'track_check') {
        throw new Error('expected a track_check rule');
      }
      expect(rule.process.length).toBeGreaterThan(0);
    });
  }
});

describe('H.3 example skills — fixture evaluation', () => {
  for (const name of EXAMPLE_NAMES) {
    it(`${name} fixtures all evaluate to expected verdict`, async () => {
      const fixtureDir = join(EXAMPLES_ROOT, name, 'fixtures');
      const entries = await fs.readdir(fixtureDir);
      const inputs = entries.filter((e) => e.endsWith('.input.json')).sort();
      // Sanity: at least 2 fixtures per example per H.3 spec.
      expect(inputs.length).toBeGreaterThanOrEqual(2);
      for (const inputFile of inputs) {
        const stem = inputFile.replace(/\.input\.json$/, '');
        const expectedFile = `${stem}.expected.json`;
        const inputRaw = await fs.readFile(join(fixtureDir, inputFile), 'utf-8');
        const expectedRaw = await fs.readFile(join(fixtureDir, expectedFile), 'utf-8');
        const input = JSON.parse(inputRaw) as FixtureInput;
        const expected = JSON.parse(expectedRaw) as FixtureExpected;
        const bindings = toBindingMap(input.bindings);
        const result = evalCondition(input.if, bindings);
        expect(result, `${name}/${stem}`).toBe(expected.verdict);
      }
    });
  }
});

describe('H.3 grammar guide — every documented if: sample parses', () => {
  it('all if: clauses inside fenced yaml blocks in docs/skill-grammar-guide.md are valid grammar', async () => {
    const md = await fs.readFile(GRAMMAR_GUIDE, 'utf-8');
    // Extract every fenced ```yaml block and within each, find every
    // `if:` line. The clause is everything after the colon; quotes are
    // stripped if present.
    const yamlBlockRe = /```yaml\n([\s\S]*?)\n```/g;
    const ifLineRe = /^\s*if:\s*(.+?)\s*$/gm;
    const clauses: string[] = [];
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = yamlBlockRe.exec(md)) !== null) {
      const block = blockMatch[1]!;
      let ifMatch: RegExpExecArray | null;
      const localRe = new RegExp(ifLineRe.source, ifLineRe.flags);
      while ((ifMatch = localRe.exec(block)) !== null) {
        let clause = ifMatch[1]!.trim();
        // Strip a trailing YAML comment (` # ...` outside the quoted
        // clause). The guide annotates several samples with explanatory
        // trailing comments; those are not part of the expression.
        // We only strip after the outermost quote pair closes — a `#`
        // inside a quoted string stays.
        clause = stripTrailingYamlComment(clause);
        // Strip a single layer of surrounding single or double quotes.
        if (
          (clause.startsWith("'") && clause.endsWith("'")) ||
          (clause.startsWith('"') && clause.endsWith('"'))
        ) {
          clause = clause.slice(1, -1);
        }
        // Skip prose placeholders like `if: <cond>` and YAML continuation
        // markers — only feed real-looking expressions to parseExpression.
        if (clause.length === 0) continue;
        if (clause.includes('<') && clause.includes('>')) continue;
        // Skip the deliberately-shown literal `false` clause from §6.2 —
        // it's a one-token literal and parses fine, but include it
        // anyway as a sanity touch.
        clauses.push(clause);
      }
    }
    // Sanity: the guide does ship multiple worked clauses.
    expect(clauses.length).toBeGreaterThanOrEqual(10);
    // Every clause must parse without throwing.
    for (const clause of clauses) {
      expect(() => parseExpression(clause), `clause: ${clause}`).not.toThrow();
    }
  });
});
