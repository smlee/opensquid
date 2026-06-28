/**
 * `frontend_audit` primitive — the PRE-DELIVERY enforcement engine (T-frontend-design-pack FD5).
 *
 * The output counterpart to the input lenses: where a lens SURFACES guidance, this AUDITS delivered frontend
 * code against the statically-detectable CRITICAL/HIGH rules and returns structured findings. The pre-delivery
 * gate (skills/predelivery-gate) calls it and emits `verdict: block` when any CRITICAL finding exists — the
 * "lenses → proper output" enforcement the spec requires (FD5 acceptance: "gate blocks on a seeded CRITICAL
 * violation"). Each detector maps to a real rule id in the bundled knowledge datasets, so a finding cites a
 * primary source (w3.org) — the citation is enriched from `knowledge/accessibility.json` at runtime, but the
 * detector's severity is INTRINSIC (baked in) so the audit is robust even if the dataset read fails (FAIL-CLOSED
 * for enforcement: a finding is reported regardless of dataset availability).
 *
 * Detectors are deliberately HIGH-PRECISION (low false positive) — only unambiguous, machine-decidable patterns:
 *   - img-no-alt              → wcag-1.1.1-alt-text   (critical) — an <img> with no alt attribute
 *   - click-on-noninteractive → wcag-2.1.1-keyboard   (critical) — onClick/onclick on a div/span with no role
 *   - outline-none            → wcag-2.4.7-focus-visible (high)  — outline:none|0 with no :focus-visible nearby
 * Contrast (wcag-1.4.3) is intentionally NOT a static detector — it needs computed color pairs and would be
 * false-positive-prone; it stays a lens-surfaced check, not a blocking gate.
 *
 * PURE core (`auditContent` / `auditFiles`) for testability; the primitive wraps it and enriches citations.
 */
import { z } from 'zod';

import { readKnowledgeDataset } from './knowledge_lookup.js';
import { ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

export type Severity = 'critical' | 'high';

export interface Finding {
  ruleId: string;
  severity: Severity;
  detector: string;
  file: string;
  line: number;
  snippet: string;
  /** Enriched from the knowledge dataset when available (title + primary source url). */
  title?: string;
  sourceUrl?: string;
}

export interface AuditResult {
  findings: Finding[];
  critical: number;
  high: number;
  /** true ⟺ no CRITICAL findings (the gate-pass predicate). */
  clean: boolean;
  filesScanned: number;
}

/** Frontend file extensions the audit scans (markup/component/style). Other files are skipped entirely. */
const FRONTEND_EXT = /\.(html?|jsx|tsx|vue|svelte|astro|css|scss)$/i;

const isFrontendFile = (path: string): boolean => FRONTEND_EXT.test(path);

/** Detector: an <img …> opening tag with no `alt` attribute. JSX/HTML, self-closing or not. */
function detectImgNoAlt(line: string): string | null {
  // Match each <img ...> opening tag on the line; flag the first lacking an alt= attribute.
  const tagRe = /<img\b[^>]*?\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(line)) !== null) {
    const tag = m[0];
    if (!/\balt\s*=/.test(tag)) return tag.trim();
  }
  return null;
}

/** Detector: onClick/onclick on a non-interactive element (div/span/li/p) with no role= → keyboard-dead. */
function detectClickOnNonInteractive(line: string): string | null {
  const tagRe = /<(div|span|li|p|td|tr)\b[^>]*?>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(line)) !== null) {
    const tag = m[0];
    if (/\bon[Cc]lick\s*=/.test(tag) && !/\brole\s*=/.test(tag)) return tag.trim();
  }
  return null;
}

/** Detector: `outline: none|0` in CSS/inline style with no `:focus-visible` re-style in the same file. */
function detectOutlineNone(line: string): string | null {
  const m = /outline\s*:\s*(none|0)\b/i.exec(line);
  return m ? m[0] : null;
}

const truncate = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** PURE — audit one file's content; returns findings (no citation enrichment, intrinsic severity only). */
export function auditContent(path: string, content: string): Finding[] {
  if (!isFrontendFile(path)) return [];
  const findings: Finding[] = [];
  const lines = content.split('\n');
  const fileHasFocusVisible = content.includes(':focus-visible');
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const img = detectImgNoAlt(line);
    if (img !== null)
      findings.push({
        ruleId: 'wcag-1.1.1-alt-text',
        severity: 'critical',
        detector: 'img-no-alt',
        file: path,
        line: lineNo,
        snippet: truncate(img),
      });
    const click = detectClickOnNonInteractive(line);
    if (click !== null)
      findings.push({
        ruleId: 'wcag-2.1.1-keyboard',
        severity: 'critical',
        detector: 'click-on-noninteractive',
        file: path,
        line: lineNo,
        snippet: truncate(click),
      });
    // outline:none is only a finding when the file provides NO :focus-visible replacement anywhere.
    const outline = detectOutlineNone(line);
    if (outline !== null && !fileHasFocusVisible)
      findings.push({
        ruleId: 'wcag-2.4.7-focus-visible',
        severity: 'high',
        detector: 'outline-none',
        file: path,
        line: lineNo,
        snippet: truncate(outline),
      });
  });
  return findings;
}

/** PURE — audit a set of {path, content} files into an aggregate result. */
export function auditFiles(files: readonly { path: string; content: string }[]): AuditResult {
  const findings = files.flatMap((f) => auditContent(f.path, f.content));
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const high = findings.filter((f) => f.severity === 'high').length;
  return {
    findings,
    critical,
    high,
    clean: critical === 0,
    filesScanned: files.filter((f) => isFrontendFile(f.path)).length,
  };
}

const FileInput = z.object({ path: z.string(), content: z.string() });
const FrontendAuditArgs = z
  .object({
    /** Files to audit, content provided (the gate passes the changed working-tree files). */
    files: z.array(FileInput),
  })
  .strict();

/** Enrich findings with title + primary source url from the accessibility dataset (best-effort, non-fatal). */
async function enrich(findings: Finding[]): Promise<Finding[]> {
  const ds = await readKnowledgeDataset('fullstack-flow', 'accessibility');
  if (ds === null) return findings; // citation unavailable → findings still stand (fail-closed for enforcement)
  const byId = new Map(ds.rules.map((r) => [r.id, r]));
  return findings.map((f) => {
    const rule = byId.get(f.ruleId);
    return rule ? { ...f, title: rule.title, sourceUrl: rule.source.url } : f;
  });
}

export function registerFrontendAudit(registry: FunctionRegistry): void {
  registry.register({
    name: 'frontend_audit',
    argSchema: FrontendAuditArgs,
    durable: false,
    memoizable: false, // scans live working-tree content each call
    costEstimateMs: 5,
    execute: async ({ files }) => {
      const result = auditFiles(files);
      const findings = await enrich(result.findings);
      return ok({ ...result, findings } satisfies AuditResult);
    },
  });
}
