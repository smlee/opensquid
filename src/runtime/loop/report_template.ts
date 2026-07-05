/**
 * `report_template` — the report-type dictionary reader (opensquid-reporting-model §7.2 build-decision #2).
 *
 * Materializes the 9-type report dictionary defined in `docs/design/opensquid-reporting-model.md`
 * (§1 the 9 types, §4 the before/after template spine, §5 the per-scope vocabularies, §5.5 the escalation
 * shape) as shipped core md-templates + a json-schema of the report structure.
 *
 * There are exactly 9 report types = (before + after) × 4 scopes {stage, task, session, system} + escalation.
 *
 * Resolution MIRRORS `src/functions/read_rubric.ts`: pack-file-by-`pack`, MODULE-RELATIVE to the opensquid
 * package (via `fileURLToPath(import.meta.url)`, NOT cwd / CLAUDE_PROJECT_DIR — the sub-repo-vs-umbrella cwd
 * split cannot misresolve it). It ADDS the core-default fallback `read_rubric` lacks: a pack MAY override a
 * template, but the CORE default ALWAYS exists, so a resolve NEVER returns null. Templates live at
 * `packs/builtin/<pack>/reports/<type>.md` (override) and `packs/builtin/_core/reports/<type>.md` (core).
 *
 * CRITICAL: report templates NEVER use the `🦑` emoji — it is RESERVED for drift / gate-trigger / blocked
 * notices (§4). Every template leads with a PLAIN header.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The 9 report types: (before + after) × 4 scopes + escalation (§1). */
export const REPORT_TYPES = [
  'before-stage',
  'after-stage',
  'before-task',
  'after-task',
  'before-session',
  'after-session',
  'before-system',
  'after-system',
  'escalation',
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

/** Generous sanity ceiling, well above the few-KB prose template; over-cap override → fall to core. */
const MAX_TEMPLATE = 64_000;

// dist/runtime/loop/report_template.js → ../../.. = the package root; under vitest the same file runs from
// src/runtime/loop/, which is ALSO 3 levels deep, so the identical relative path resolves the repo root in
// both builds. `packs/builtin` lives at the package/repo root.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The report-structure json-schema (draft-07 style plain object literal), matching §4's spine:
 * - `before`  = { subject, summary, checklist[] }   — the commitment, decomposed at scope entry.
 * - `after`   = { subject, checklist[] resolved, produced, gates, next } — the same checklist resolved at
 *   exit (each item ✓done+evidence / ✗not_done+reason), plus what was produced, gates passed, and handoff.
 * - `escalation` = { subject, reason, context, needed } — the interrupt shape (§5.5), NO checklist.
 */
export const REPORT_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://opensquid.dev/schema/report.json',
  title: 'OpenSquid report',
  description:
    'The generalized report structure (opensquid-reporting-model §4): one checklist, two renders — a before ' +
    '(commitment) and an after (the same checklist resolved) — plus the escalation interrupt shape.',
  oneOf: [{ $ref: '#/$defs/before' }, { $ref: '#/$defs/after' }, { $ref: '#/$defs/escalation' }],
  $defs: {
    beforeChecklistItem: {
      type: 'object',
      description: 'A concrete intended outcome (the commitment) — homed on the workgraph (§4.2).',
      required: ['item'],
      additionalProperties: false,
      properties: {
        item: {
          type: 'string',
          description: 'The intended outcome, in the scope pack vocabulary.',
        },
        wgIssue: {
          type: 'string',
          description: 'Optional workgraph sub-issue id backing this item.',
        },
      },
    },
    afterChecklistItem: {
      type: 'object',
      description:
        'A before-item resolved: ✓done (with evidence) or ✗not_done (with reason). None dangling.',
      required: ['item', 'status'],
      additionalProperties: false,
      properties: {
        item: { type: 'string' },
        wgIssue: { type: 'string' },
        status: { type: 'string', enum: ['done', 'not_done'] },
        evidence: {
          type: 'string',
          description: 'file:line / artifact / gate — required when done.',
        },
        reason: {
          type: 'string',
          description: 'Why deferred / not done — required when not_done.',
        },
      },
    },
    before: {
      type: 'object',
      description: 'Before (surfaced): the scope decomposed into a commitment (§4).',
      required: ['subject', 'summary', 'checklist'],
      additionalProperties: false,
      properties: {
        subject: {
          type: 'string',
          description: 'What this scope addresses (from the prompt/goal).',
        },
        summary: { type: 'string', description: '1–2 lines of intent.' },
        checklist: {
          type: 'array',
          description: 'The concrete intended outcomes — the commitment.',
          items: { $ref: '#/$defs/beforeChecklistItem' },
        },
      },
    },
    after: {
      type: 'object',
      description:
        'After (saved): the same checklist resolved, plus what was produced, gates, and handoff (§4).',
      required: ['subject', 'checklist', 'produced', 'gates', 'next'],
      additionalProperties: false,
      properties: {
        subject: { type: 'string', description: 'Same subject as the matching before.' },
        checklist: {
          type: 'array',
          description: 'Each before-item resolved ✓/✗ — a valid after resolves every item.',
          items: { $ref: '#/$defs/afterChecklistItem' },
        },
        produced: {
          type: 'string',
          description: 'What was actually made — diffs / artifacts / evidence.',
        },
        gates: { type: 'string', description: 'Which gates passed.' },
        next: { type: 'string', description: 'Handoff to the next scope / what is now unblocked.' },
      },
    },
    escalation: {
      type: 'object',
      description: 'The interrupt (§5.5): a decision-request, not a work-record — NO checklist.',
      required: ['subject', 'reason', 'context', 'needed'],
      additionalProperties: false,
      properties: {
        subject: { type: 'string', description: 'The blocker.' },
        reason: {
          type: 'string',
          description: 'The escalation kind.',
          enum: [
            'HUMAN_REQUIRED',
            'IRREVERSIBLE_BOUNDARY',
            'SCOPE_FORK',
            'BOARD_EMPTY',
            'wedge',
            'BUDGET',
          ],
        },
        context: {
          type: 'string',
          description: "What's blocked — task / stage / item + evidence.",
        },
        needed: {
          type: 'string',
          description: 'The decision/action required from the human (+ options).',
        },
      },
    },
  },
};

/**
 * Resolve a report template: pack override FIRST, then the CORE default (which ALWAYS exists → never null).
 *
 * Tries `packs/builtin/<pack>/reports/<type>.md`; on miss (or an over-cap override) reads the shipped
 * `packs/builtin/_core/reports/<type>.md` and returns its content. If even the core is missing it throws —
 * the core template set is a shipped invariant (all 9 files exist), so under normal operation it cannot.
 */
export async function readReportTemplate(type: ReportType, pack: string): Promise<string> {
  try {
    const override = await readFile(
      join(PKG_ROOT, 'packs', 'builtin', pack, 'reports', `${type}.md`),
      'utf8',
    );
    if (override.length <= MAX_TEMPLATE) return override;
  } catch {
    // no pack override (or over-cap) — fall through to the core default.
  }
  // Core is a shipped invariant: readFile throws if it is somehow missing (fail-loud), never truncates.
  return readFile(join(PKG_ROOT, 'packs', 'builtin', '_core', 'reports', `${type}.md`), 'utf8');
}
