#!/usr/bin/env node
// Smoke-test harness for the seo-aeo-expert pack (spec §11 acceptance:
// every rule ≥2 cases, trigger + non-trigger; exit non-zero on any failure).
//
// Two input shapes per case (fixtures/<skill>/<case>.input.json):
//   1. Binding mode: { "if": "<expr>", "bindings": { ... } }
//      — pre-computed bindings, evaluates the expression directly. Used for
//      rules whose bindings come from match_command / read_fsm_state.
//   2. Event mode:   { "rule": "<rule-id>", "event": { "tool": "...", "args": { ... } } }
//      — loads ../skills/<skill>/skill.yaml, emulates every
//      text_pattern_match step of that rule against the event (this
//      exercises the REAL regexes), then evaluates the rule's final
//      verdict/advance `if:`. Step `if:` gating is intentionally ignored
//      (the verdict expression carries the logic), mirroring the
//      sangmin-personal-rules fp-walk emulation.
// Expected shape: { "verdict": true|false }.
//
// Invocation: node packs/builtin/seo-aeo-expert/fixtures/run.mjs

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from '/Users/slee/projects/loop/opensquid/node_modules/yaml/dist/index.js';
import { evalCondition } from '/Users/slee/projects/loop/opensquid/dist/runtime/evaluator/expression/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(dirname(HERE), 'skills');

function bindingsToMap(obj) {
  const m = new Map();
  for (const [k, v] of Object.entries(obj || {})) m.set(k, v);
  return m;
}

function readField(event, dottedField) {
  if (!dottedField) return '';
  return dottedField.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), event) ?? '';
}

function matchPatterns(text, patterns) {
  if (!text || typeof text !== 'string') return [];
  const hits = [];
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'gi').test(text)) hits.push(p);
    } catch {
      /* invalid pattern — treated as no-match, same as runtime */
    }
  }
  return hits;
}

async function evalEventCase(skillName, input) {
  const skill = parseYaml(await readFile(join(SKILLS_DIR, skillName, 'skill.yaml'), 'utf8'));
  const rule = (skill.rules || []).find((r) => r.id === input.rule);
  if (!rule) throw new Error(`rule ${input.rule} not found in ${skillName}`);
  const bindings = new Map();
  let finalIf = null;
  for (const step of rule.process || []) {
    if (step.call === 'text_pattern_match' && step.as) {
      const text = readField(input.event, step.args?.text_field);
      bindings.set(step.as, { matched: matchPatterns(text, step.args?.patterns || []) });
    }
    if ((step.call === 'verdict' || step.call === 'advance_fsm') && step.if) finalIf = step.if;
  }
  if (!finalIf) throw new Error(`rule ${input.rule}: no verdict/advance if-expression`);
  return evalCondition(finalIf, bindings);
}

async function loadFixturePairs(skillDir) {
  const entries = await readdir(skillDir);
  const cases = new Map();
  for (const f of entries) {
    const m = f.match(/^(.+)\.(input|expected)\.json$/);
    if (!m) continue;
    const [, name, kind] = m;
    if (!cases.has(name)) cases.set(name, {});
    cases.get(name)[kind] = JSON.parse(await readFile(join(skillDir, f), 'utf8'));
  }
  return [...cases.entries()].map(([name, pair]) => ({ name, ...pair }));
}

const skillDirs = (await readdir(HERE, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let total = 0;
let pass = 0;
for (const skillName of skillDirs) {
  const pairs = await loadFixturePairs(join(HERE, skillName));
  let sPass = 0;
  const failures = [];
  for (const { name, input, expected } of pairs) {
    total++;
    if (!input || !expected) {
      failures.push(`${name}: missing input or expected`);
      continue;
    }
    let got;
    try {
      got =
        input.event !== undefined
          ? await evalEventCase(skillName, input)
          : evalCondition(input.if, bindingsToMap(input.bindings));
    } catch (e) {
      failures.push(`${name}: ERROR ${e.message}`);
      continue;
    }
    if (got === expected.verdict) {
      pass++;
      sPass++;
    } else {
      failures.push(`${name}: expected=${expected.verdict} got=${got}`);
    }
  }
  console.log(
    `  ${failures.length === 0 ? 'PASS' : 'FAIL'} ${skillName}: ${sPass}/${pairs.length}`,
  );
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`=== TOTAL: ${pass}/${total} ===`);
process.exit(pass === total ? 0 : 1);
