import type { SkillOutput } from '../../packs/loader.js';
import type { AuditBinding } from '../../packs/schemas/pack_v2.js';
import { readRubricContent } from '../../functions/read_rubric.js';
import { sha256Hex } from '../durable/run_id.js';

export interface AuditCacheLens {
  readonly id: string;
  readonly promptHash: string;
}

export interface ScopeAuditEntry {
  readonly verdict: string;
  readonly subjectHash?: string;
  readonly complete?: boolean;
  readonly lenses?: readonly AuditCacheLens[];
}

export interface ScopeAuditPolicy {
  readonly lenses: readonly { readonly id: string; readonly promptTemplate: string }[];
  readonly rubric: string;
}

export function scopeAuditExpectedLenses(
  artifact: string,
  policy: ScopeAuditPolicy,
): readonly AuditCacheLens[] {
  return policy.lenses.map((lens) => ({
    id: lens.id,
    promptHash: sha256Hex(
      lens.promptTemplate
        .replaceAll('{{rubric}}', policy.rubric)
        .replaceAll('{{effective}}', artifact),
    ),
  }));
}

export function auditEntryCertifiesSubject(
  entry: ScopeAuditEntry | null,
  currentHash: string,
  expectedLenses?: readonly AuditCacheLens[],
): boolean {
  if (entry?.subjectHash !== currentHash) return false;
  if (expectedLenses === undefined) return true;
  if (entry.complete !== true || entry.lenses?.length !== expectedLenses.length) return false;
  const actual = new Map(entry.lenses.map((lens) => [lens.id, lens.promptHash]));
  return (
    actual.size === expectedLenses.length &&
    expectedLenses.every((lens) => actual.get(lens.id) === lens.promptHash)
  );
}

export async function readAuditPolicy(
  packName: string,
  skills: readonly SkillOutput[],
  binding: AuditBinding,
): Promise<ScopeAuditPolicy | null | undefined> {
  for (const skill of skills) {
    for (const rule of skill.rules) {
      if (rule.id !== binding.rule || !('process' in rule)) continue;
      const step = rule.process.find((candidate) => candidate.call === 'cached_audit');
      const rawLenses = step?.args?.lenses;
      if (!Array.isArray(rawLenses)) return null;
      const lenses = rawLenses.flatMap((value) => {
        if (
          value === null ||
          typeof value !== 'object' ||
          typeof (value as { id?: unknown }).id !== 'string' ||
          typeof (value as { prompt?: unknown }).prompt !== 'string'
        ) {
          return [];
        }
        return [
          {
            id: (value as { id: string }).id,
            promptTemplate: (value as { prompt: string }).prompt,
          },
        ];
      });
      if (
        lenses.length !== rawLenses.length ||
        new Set(lenses.map((lens) => lens.id)).size !== lenses.length
      ) {
        return null;
      }
      const rubric = await readRubricContent(binding.rubric, packName);
      return rubric === null ? null : { lenses, rubric };
    }
  }
  return undefined;
}
