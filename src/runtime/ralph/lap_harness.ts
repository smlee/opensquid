/**
 * MHL.3 — the NEUTRAL lap-harness seam + kind→adapter resolver (T-multi-harness-lap).
 *
 * The loop core carries ZERO vendor identity: every harness-specific decision at the lap boundary (the
 * invocation flags, the prompt-delivery channel, the raw-output→envelope parse, an optional fail-loud
 * preflight) lives behind a `LapHarness` adapter selected by a `kind: 'claude' | 'codex'` discriminator.
 * This is the SAME neutrality contract as `src/models/dispatcher.ts` (a kind→strategy resolver that throws
 * on an unknown provider) + `src/models/strategies/subscription_cli.ts` (the audit-grep-empty header).
 *
 * The audit-grep-empty acceptance (lap_neutrality.test.ts, MHL.8) asserts NO vendor INVOCATION flag or raw
 * ENVELOPE field literal survives in this file — those live ONLY in the adapters (`./harnesses/*_lap_harness.ts`)
 * + the config schema. The `kind` VALUES (`'claude'`/`'codex'`) this file dispatches on are the LEGITIMATE
 * dispatch point (exactly like `dispatcher.ts` branches on the user-supplied `provider === 'anthropic' |
 * 'openai'`), NOT vendor literals — see the deny-list documented in lap_neutrality.test.ts.
 *
 * Imported by: src/setup/cli/ralph.ts (the wire, MHL.6), src/setup/wizard/ralph_writer.ts (the load-time
 * fail-loud gate reads LAP_HARNESS_KINDS + the shared HarnessKind, MHL.2).
 */
import { claudeLapHarness } from './harnesses/claude_lap_harness.js';
import { codexLapHarness } from './harnesses/codex_lap_harness.js';

/** The lap-harness discriminator — ONE shared type (the schema enum in ralph_writer.ts references it so the
 *  config enum and the resolver cannot drift; SSOT with LAP_HARNESS_KINDS below). */
export type HarnessKind = 'claude' | 'codex';

/** A per-model rate map (generic — a rate-bearing adapter prices its token counts by it; Claude ignores it,
 *  its cost is vendor-provided). Rates are $ per 1,000,000 tokens — CONFIG (operator-supplied), never a
 *  checked-in constant, because per-model rates drift over model version. */
export interface CodexPricing {
  models: Record<string, { inputPerMTok: number; outputPerMTok: number }>; // $ per 1,000,000 tokens
  // the model id to price by when the lap's model is not otherwise resolved. `| undefined` (not a bare
  // optional) so the zod-`.optional()` config shape flows in verbatim under exactOptionalPropertyTypes.
  default?: string | undefined;
}

/** The small, vendor-free config an adapter reads (assembled at the wire from cfg.maxBudgetUsd + file.harness). */
export interface LapHarnessCfg {
  maxBudgetUsd: number;
  sandbox?: string;
  askForApproval?: string;
  model?: string; // resolved model id — a rate-bearing adapter passes it AND prices by it (run == priced)
  pricing?: CodexPricing; // per-model $/1M-token rates (Codex; Claude ignores — its cost is vendor-provided)
}

/** The harness-agnostic parse result — feeds the vendor-free `outcomeFromEnvelope` (lap_outcome.ts). Field
 *  names are neutral camelCase (never the vendor JSON/JSONL keys), so this shape leaks no vendor identity. */
export interface LapEnvelope {
  resultText: string; // the agent's final free text (scanned for RALPH-EXIT by extractTypedExit)
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  isError: boolean;
}

/** The lap-boundary seam. A future harness is a new adapter module + a `kind` value — NO core edit. */
export interface LapHarness {
  /** The CLI flags for THIS harness (replaces the once-hardcoded Claude array). */
  spawnArgs(cfg: LapHarnessCfg): string[];
  /** How the prompt reaches the child (both current adapters return `{ stdin: prompt }`; the seam lets a
   *  future harness deliver via argv/file without a core edit). */
  deliverPrompt(prompt: string): { stdin: string };
  /** Fold the harness's raw stdout/stderr → the neutral envelope. */
  parseEnvelope(stdout: string, stderr: string): LapEnvelope;
  /** OPTIONAL fail-loud setup check run BEFORE the spawn (Claude omits it; Codex implements auth diagnostics).
   *  Absent ⇒ no preflight. */
  preflight?(cfg: LapHarnessCfg): void | Promise<void>;
  /** OPTIONAL post-parse dollar pricing. An adapter whose raw stream carries no per-call cost figure computes
   *  costUsd from the envelope's token counts × the configured per-model rate; an adapter whose cost is already
   *  vendor-provided omits it. Absent ⇒ the envelope's own costUsd stands. */
  priceUsd?(env: LapEnvelope, cfg: LapHarnessCfg): number;
}

/** SSOT of the implemented kinds — read by the config load-time gate (ralph_writer.ts superRefine, MHL.2), so a
 *  `kind` value with no adapter is rejected at load, not at spawn. */
export const LAP_HARNESS_KINDS: ReadonlySet<HarnessKind> = new Set<HarnessKind>([
  'claude',
  'codex',
]);

/**
 * kind → adapter; THROWS on an unresolved kind (mirrors `dispatcher.ts:70-73`). The runtime boundary that
 * reinforces the load-time rejection (MHL.2) — a kind with no adapter never reaches a spawn.
 */
export function resolveLapHarness(kind: HarnessKind): LapHarness {
  switch (kind) {
    case 'claude':
      return claudeLapHarness;
    case 'codex':
      return codexLapHarness;
    default:
      throw new Error(
        `No LapHarness adapter for harness.kind "${String(kind)}" — implemented: ${[...LAP_HARNESS_KINDS].join(' | ')}`,
      );
  }
}
