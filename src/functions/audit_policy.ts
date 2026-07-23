import { MAX_AUDIT_CRITERION_BYTES, MAX_AUDIT_TEXT_BYTES } from '../runtime/audit_schema.js';
import type { Pack } from '../runtime/types.js';

import { AuditLensSetSchema, AuditTextSchema, type AuditLens } from './audit_fanout.js';
import { parseCachedAuditDeclaration } from './cached_audit.js';

export interface MaterializedAuditPolicy {
  readonly cacheKey: string;
  readonly model: string;
  readonly lenses: readonly AuditLens[];
  readonly passVerdict: string;
  readonly failVerdict: string;
  readonly subject: string;
  readonly timeoutMs?: number | undefined;
}

function materializeTemplate(
  template: string,
  rubric: string,
  diff: string,
  requireInputs: boolean,
  maxOutputBytes: number,
): string | null {
  if (requireInputs && (!template.includes('{{rubric}}') || !template.includes('{{diff}}'))) {
    return null;
  }
  const remainder = template.replaceAll('{{rubric}}', '').replaceAll('{{diff}}', '');
  if (remainder.includes('{{') || remainder.includes('}}')) return null;
  const replacements = [
    ['{{rubric}}', rubric],
    ['{{diff}}', diff],
  ] as const;
  let projectedBytes = Buffer.byteLength(template, 'utf8');
  for (const [token, replacement] of replacements) {
    let count = 0;
    for (
      let at = template.indexOf(token);
      at !== -1;
      at = template.indexOf(token, at + token.length)
    ) {
      count += 1;
    }
    projectedBytes +=
      count * (Buffer.byteLength(replacement, 'utf8') - Buffer.byteLength(token, 'utf8'));
  }
  if (projectedBytes > maxOutputBytes) return null;
  // One pass over the authored template: placeholder-looking bytes inside rubric/diff remain exact artifact
  // bytes and are never recursively interpreted or expanded.
  return template.replace(/\{\{rubric\}\}|\{\{diff\}\}/gu, (token) =>
    token === '{{rubric}}' ? rubric : diff,
  );
}

/** Pure projection of the complete active-pack CODE declaration; prompt and criteria share template rules. */
export function materializePackAuditPolicy(
  packs: readonly Pack[],
  packId: string,
  auditCacheKey: string,
  rubric: string,
  diff: string,
): MaterializedAuditPolicy | null {
  const pack = packs.find((candidate) => candidate.name === packId);
  if (pack === undefined) return null;
  // Bound raw substitutions before any replaceAll allocation; repeated placeholders are projected below.
  if (!AuditTextSchema.safeParse(rubric).success || !AuditTextSchema.safeParse(diff).success) {
    return null;
  }
  for (const skill of pack.skills) {
    for (const rule of skill.rules) {
      if (rule.kind !== 'track_check') continue;
      for (const step of rule.process) {
        if (step.call !== 'cached_audit') continue;
        const declaration = parseCachedAuditDeclaration(step.args);
        if (declaration === null) continue;
        if (declaration.cacheKey !== auditCacheKey || declaration.subjectTemplate !== '{{diff}}') {
          continue;
        }
        const lenses: AuditLens[] = [];
        for (const lens of declaration.lenses) {
          const prompt = materializeTemplate(lens.prompt, rubric, diff, true, MAX_AUDIT_TEXT_BYTES);
          if (prompt === null) return null;
          const criteria = lens.criteria?.map((criterion) =>
            materializeTemplate(criterion, rubric, diff, false, MAX_AUDIT_CRITERION_BYTES),
          );
          if (criteria?.some((criterion) => criterion === null)) return null;
          lenses.push({
            id: lens.id,
            prompt,
            ...(criteria === undefined ? {} : { criteria: criteria as string[] }),
          });
        }
        // Expansion can make previously valid templates/criteria/subject exceed byte bounds. Re-parse the exact
        // materialized values so gate hashing and runtime dispatch share one final policy contract.
        const materializedLenses = AuditLensSetSchema.safeParse(lenses);
        const materializedSubject = AuditTextSchema.safeParse(diff);
        if (!materializedLenses.success || !materializedSubject.success) return null;
        return {
          cacheKey: declaration.cacheKey,
          model: declaration.model,
          lenses: materializedLenses.data,
          passVerdict: declaration.passVerdict,
          failVerdict: declaration.failVerdict,
          subject: materializedSubject.data,
          ...(declaration.timeoutMs === undefined ? {} : { timeoutMs: declaration.timeoutMs }),
        };
      }
    }
  }
  return null;
}
