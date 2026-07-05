/**
 * report_template.ts tests — real fs reads of the shipped core report templates (opensquid-reporting-model
 * §7.2 build-decision #2). Under vitest the module runs from src/, whose src/runtime/loop/ is 3 levels deep
 * under the repo root — the same depth as dist/runtime/loop/ — so the module-relative PKG_ROOT resolves the
 * repo root in both, and `packs/builtin/_core/reports/` reads from the shipped core set.
 */
import { describe, expect, it } from 'vitest';

import {
  REPORT_SCHEMA,
  REPORT_TYPES,
  readReportTemplate,
  type ReportType,
} from './report_template.js';

const EXPECTED: ReportType[] = [
  'before-stage',
  'after-stage',
  'before-task',
  'after-task',
  'before-session',
  'after-session',
  'before-system',
  'after-system',
  'escalation',
];

describe('report_template', () => {
  it('REPORT_TYPES has all 9 expected values', () => {
    expect(REPORT_TYPES.length).toBe(9);
    expect([...REPORT_TYPES]).toEqual(EXPECTED);
  });

  it.each(EXPECTED)(
    'readReportTemplate(%s, "nonexistent-pack") resolves the non-empty core default, 🦑-free',
    async (type) => {
      const content = await readReportTemplate(type, 'nonexistent-pack');
      expect(content.length).toBeGreaterThan(0);
      // 🦑 is RESERVED for drift / gate notices — report templates never carry it (§4).
      expect(content).not.toContain('🦑');
    },
  );

  it('REPORT_SCHEMA is an object with the before/after fields', () => {
    expect(typeof REPORT_SCHEMA).toBe('object');
    expect(REPORT_SCHEMA).not.toBeNull();

    const defs = REPORT_SCHEMA.$defs as Record<string, unknown>;
    expect(defs).toBeDefined();

    // before spine (§4): { subject, summary, checklist[] }
    const before = defs.before as { required?: string[] };
    expect(before).toBeDefined();
    expect(before.required).toEqual(expect.arrayContaining(['subject', 'summary', 'checklist']));

    // after spine (§4): { subject, checklist[] resolved, produced, gates, next }
    const after = defs.after as { required?: string[] };
    expect(after).toBeDefined();
    expect(after.required).toEqual(
      expect.arrayContaining(['subject', 'checklist', 'produced', 'gates', 'next']),
    );
  });
});
