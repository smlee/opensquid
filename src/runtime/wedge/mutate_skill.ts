/**
 * Skill version incrementing on accepted mutations (Task 7.4).
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Phases 2–7 summary"
 * Phase 7 + §"Skill format" `version` field + `feedback_pre1_versioning`
 * (memory) — every change is a patch bump.
 *
 * When a lesson clears both gates (capture + promote), the skill it mutates
 * gets a patch bump on its `version:` field. The YAML rewrite goes through
 * the `yaml` package's Document API (`parseDocument` → `doc.set` →
 * `doc.toString()`) so comments + key ordering + anchor info survive the
 * round-trip — that's the difference between this and `JSON.parse` /
 * `JSON.stringify`, which would shred user-authored comments inside the
 * skill manifest.
 *
 * Failure modes:
 *
 *   - File missing → fs error propagates (caller's job to handle).
 *   - Missing `version:` key → defaults to `0.0.0` (so first bump produces
 *     `0.0.1`). Per `project_opensquid_out_of_the_box`, undefined fields
 *     should DTRT, not fail.
 *   - Invalid semver string → throws explicitly. The agent should never bump
 *     a malformed version silently; the throw forces the user to fix the
 *     manifest before the wedge gate can mutate it.
 *
 * Imports from: node:fs/promises, yaml, semver.
 * Imported by: src/runtime/wedge/index.ts, Phase 8 mutation pipeline.
 */

import { readFile, writeFile } from 'node:fs/promises';

import semver from 'semver';
import { parseDocument } from 'yaml';

// ---------------------------------------------------------------------------
// bumpSkillVersion — patch-bump the `version:` field of a skill YAML.
//
// Returns the new version string. Throws on invalid existing version.
//
// Comment preservation: we use `parseDocument` (not the lighter `parse`) and
// `doc.toString()` (not `stringify(doc.toJSON())`) so that comments + key
// ordering + anchors survive the round-trip. This is the same pattern used
// in `src/packs/yaml.ts`'s `serializeYamlDocument` — kept inline here to
// avoid the extra schema-validation step (we only touch one field).
// ---------------------------------------------------------------------------

export async function bumpSkillVersion(skillYamlPath: string): Promise<string> {
  const raw = await readFile(skillYamlPath, 'utf8');
  const doc = parseDocument(raw, { strict: true });
  if (doc.errors.length > 0) {
    const msg = doc.errors.map((e) => e.message).join('; ');
    throw new Error(`YAML parse errors in ${skillYamlPath}: ${msg}`);
  }

  const cur = (doc.get('version') as string | undefined) ?? '0.0.0';
  if (typeof cur !== 'string') {
    throw new Error(`Skill version must be a string, got ${typeof cur}: ${skillYamlPath}`);
  }
  const next = semver.inc(cur, 'patch');
  if (!next) {
    throw new Error(`Cannot bump invalid version: ${cur} (in ${skillYamlPath})`);
  }

  doc.set('version', next);
  await writeFile(skillYamlPath, doc.toString(), 'utf8');
  return next;
}
