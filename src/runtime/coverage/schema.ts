/**
 * CFD.1 — the requirement-manifest schema + extractor (the in-repo, deterministic coverage manifest).
 *
 * A design's checkable requirements are embedded IN its authoritative in-repo file — a pack's `pack.yaml`
 * (`foundation.requirements`) or a git-tracked design `.md` (a fenced ```yaml requirements``` block). The
 * coverage checker (`check.ts`) verifies each against the code; this module only parses/validates the manifest.
 *
 * Spec: loop/docs/tasks/T-v2-coverage-foundation.md (Track 0 of the 0.6.0 cutover).
 */
import { z } from 'zod';
import { parse as yamlParse } from 'yaml';

// The four deterministically-checkable assert kinds (all snake_case — the YAML wire shape; `.strict()`).
const Reachable = z
  .object({
    kind: z.literal('reachable'),
    symbol: z.string().min(1),
    from: z.array(z.string().min(1)).min(1),
  })
  .strict();
const Absent = z.object({ kind: z.literal('absent'), symbol: z.string().min(1) }).strict();
const Binding = z
  .object({ kind: z.literal('binding'), ctx_key: z.string().min(1), in: z.string().min(1) })
  .strict();
const Proof = z.object({ kind: z.literal('proof'), test: z.string().min(1) }).strict();

export const Assert = z.discriminatedUnion('kind', [Reachable, Absent, Binding, Proof]);
export type Assert = z.infer<typeof Assert>;

export const Requirement = z
  .object({
    id: z.string().regex(/^R-[A-Z0-9][A-Z0-9-]*$/), // stable, greppable ID
    intent: z.string().min(1),
    spec: z.string().min(1).optional(),
    wg: z
      .string()
      .regex(/^wg-[a-f0-9]{12}$/)
      .optional(),
    assert: Assert,
    proof: z.string().min(1).optional(), // a live-path test; the AUTHORITY for non-`absent` (check.ts)
  })
  .strict()
  .superRefine((r, ctx) => {
    // doc-rubric, enforced in-schema: `reachable`/`binding` need a `proof`-test backstop (the authority).
    // `absent` needs none (absence IS the proof); `proof` carries its test inline in `assert.test`.
    if ((r.assert.kind === 'reachable' || r.assert.kind === 'binding') && r.proof === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proof'],
        message: `${r.assert.kind} requirement ${r.id} requires a proof-test`,
      });
  });
export type Requirement = z.infer<typeof Requirement>;

/**
 * Extract requirements from a design's authoritative file: a fenced ```yaml requirements``` block in a `.md`,
 * or `foundation.requirements` in a `pack.yaml`. Fail-loud on a malformed manifest (the doc-rubric).
 */
export function extractRequirements(path: string, content: string): Requirement[] {
  const raw = path.endsWith('.md')
    ? fencedRequirementsBlock(content)
    : foundationRequirements(content);
  return z.array(Requirement).parse(raw);
}

/** The first ```yaml requirements ...``` fenced block's `requirements:` array (or [] if absent). */
function fencedRequirementsBlock(md: string): unknown {
  const m = /```ya?ml\s+requirements\b[^\n]*\n([\s\S]*?)```/.exec(md);
  const body = m?.[1];
  if (body === undefined) return [];
  const doc = yamlParse(body) as { requirements?: unknown } | null;
  return doc?.requirements ?? [];
}

/** `foundation.requirements` from a pack.yaml (or [] if absent). */
function foundationRequirements(yamlText: string): unknown {
  const doc = yamlParse(yamlText) as { foundation?: { requirements?: unknown } } | null;
  return doc?.foundation?.requirements ?? [];
}
