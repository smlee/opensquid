/**
 * Knowledge-base schemas (T-frontend-design-pack FD1) — the typed shape of a bundled design-knowledge dataset
 * that the `knowledge_lookup` primitive reads at runtime.
 *
 * A dataset is one lens's worth of PRIMARY-SOURCED, threshold-bearing, cited rules (e.g. `accessibility.json`,
 * `visual-design.json`). It lives at `packs/builtin/<pack>/knowledge/<lens>.json` and is `.strict()`-validated
 * on load — a malformed dataset FAILS LOUD (the reader returns null; no silent partial), fixing the reference
 * skill's "CSV not schema-validated" weakness (S1 §C.8).
 *
 * Every rule MUST carry a primary `source` (URL + optional spec ref) — the tier-0 invariant that separates
 * cited, auditable, version-pinnable knowledge from the secondhand encyclopedia we are replacing.
 */
import { z } from 'zod';

/** Severity drives enforcement: `critical` is what the pre-delivery OUTPUT gate blocks on. */
export const KnowledgeSeverity = z.enum(['critical', 'high', 'medium', 'low']);
export type KnowledgeSeverity = z.infer<typeof KnowledgeSeverity>;

/** A primary-source citation — the provenance every tier-0 rule must carry. */
export const KnowledgeSource = z
  .object({
    name: z.string().min(1), // e.g. "WCAG 2.2", "web.dev", "Material 3"
    url: z.string().url(),
    ref: z.string().min(1).optional(), // e.g. "SC 2.5.8", "INP", "type-scale-tokens"
  })
  .strict();
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

/** One atomic, testable design rule. */
export const KnowledgeRule = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    /** Coarse grouping within the lens (e.g. "forms", "contrast", "tokens"). */
    category: z.string().min(1).optional(),
    /** Platform scope when applicable (web/ios/android/all). */
    platform: z.string().min(1).optional(),
    severity: KnowledgeSeverity,
    /** The guidance, stated as a checkable predicate where possible (carries the threshold). */
    rule: z.string().min(1),
    do: z.string().min(1).optional(),
    dont: z.string().min(1).optional(),
    /** Minimal good/bad code illustrations. */
    good: z.string().min(1).optional(),
    bad: z.string().min(1).optional(),
    /** Free tags for retrieval (queried by `knowledge_lookup`). */
    tags: z.array(z.string().min(1)).optional(),
    source: KnowledgeSource,
    spec_version: z.string().min(1).optional(),
  })
  .strict();
export type KnowledgeRule = z.infer<typeof KnowledgeRule>;

/** A full dataset = one lens's rule set. */
export const KnowledgeDataset = z
  .object({
    schema_version: z.literal(1),
    /** The lens this dataset backs (e.g. "accessibility", "visual-design"). */
    lens: z.string().min(1),
    description: z.string().min(1).optional(),
    rules: z.array(KnowledgeRule).min(1),
  })
  .strict();
export type KnowledgeDataset = z.infer<typeof KnowledgeDataset>;
