/**
 * GR.4 — the gated-ralph wizard writer (Inv 12: wizard-configured, never hand-wired).
 *
 * Installs the two on-disk artifacts the `opensquid loop` orchestrator reads:
 *   1. `~/.opensquid/RALPH.md`        — the stable per-lap directive (the `RALPH_MD` constant).
 *   2. `~/.opensquid/ralph.config.json` — the loop config (auth-mode, budget/rate caps, supervisor
 *      bounds, harness), validated by `RalphConfigFileSchema` on read (fail-loud, the project invariant).
 *
 * Both writes are IDEMPOTENT: an identical existing file is a no-op; a divergent one is snapshotted to
 * `<file>.bak` before the atomic overwrite (same contract as settings-writer). Absent config ⇒ the loop
 * is OFF (the CLI refuses to run without it) ⇒ today's behavior is unchanged (additive, Inv 12).
 *
 * Persisted config stores only SCALARS (no functions) — the CLI reconstructs the orchestrator's
 * `RalphConfig` (the `backoffMs`/`heartbeat`/`sleep` closures) from these at launch.
 *
 * Imports from: node:fs/promises, ../../runtime/atomic_write.js, ../../runtime/paths.js,
 * ../../runtime/ralph/ralph_template.js, zod.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../../runtime/atomic_write.js';
import { OPENSQUID_HOME } from '../../runtime/paths.js';
import { RALPH_MD } from '../../runtime/ralph/ralph_template.js';
import { LAP_HARNESS_KINDS, type HarnessKind } from '../../runtime/ralph/lap_harness.js';

/** SSOT: the schema enum's members ARE the resolver's HarnessKind — `satisfies` is a compile-time drift guard
 *  (adding a kind here that the resolver's HarnessKind doesn't know is a type error, and vice-versa via the enum). */
const HARNESS_KINDS = ['claude', 'codex'] as const satisfies readonly HarnessKind[];

export const RalphConfigFileSchema = z
  .object({
    /** Auth mode resolves the per-lap bound (Inv 11): API → dollar budget; subscription → wall-clock W. */
    authMode: z.enum(['api', 'subscription']),
    /** API dollar budget (running sum of the verified total_cost_usd). Ignored in subscription mode. */
    maxBudgetUsd: z.number().positive(),
    /** Per-item claim TTL (GR.1). */
    claimTtlSec: z.number().int().positive(),
    /** Per-lap wall-clock deadline W (the subscription bound + the TIMEOUT trigger). */
    wallClockMs: z.number().int().positive(),
    /** Supervisor retry cap R (CRASH/TIMEOUT only) and the backoff base for exponential backoff. */
    maxRetries: z.number().int().nonnegative(),
    backoffBaseMs: z.number().int().positive(),
    /** Harness is a PARAMETER (Inv 10): the lap CLI + the RALPH.md path it reads, PLUS the lap-harness
     *  discriminator + per-kind settings (MHL.1). */
    harness: z.object({
      cli: z.string().min(1), // the opaque binary name/path (unchanged)
      ralphMdPath: z.string().min(1),
      /** The lap-harness discriminator (scope-1). Selects the LapHarness adapter (MHL.3 resolver). The
       *  `.default('claude')` is LOAD-BEARING: every existing config (no `kind`) parses byte-unchanged. An
       *  unimplemented kind is rejected fail-loud by the superRefine below (MHL.2). */
      kind: z.enum(HARNESS_KINDS).default('claude'),
      /** Per-kind Codex policy (FORK LOCKED §5 Q1) — explicit, NOT an auto-translation of --dangerously-*.
       *  `sandbox` → `codex exec --sandbox <v>`; `askForApproval` → `codex exec -c approval_policy=<v>`
       *  (--ask-for-approval is not a `codex exec` flag in 0.144.0). `askForApproval` stays a permissive
       *  string so a new policy vocabulary needs no schema bump. Autonomous-lap defaults live in the Codex
       *  adapter (MHL.5): sandbox='workspace-write', approval_policy='never'. */
      sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
      askForApproval: z.string().optional(),
      /** Codex financial-safety (CFS.1): the resolved model id + the per-model $/1M-token rate map. Both
       *  optional → every existing config parses byte-unchanged (the same load-bearing default-preservation
       *  contract as `kind`). `model` (when set) is passed as `codex exec -m <model>` AND priced by, so the
       *  RUN model == the PRICED model. `pricing` rates are $ per 1,000,000 tokens, operator-supplied (OpenAI
       *  per-model rates drift over version — CONFIG, never a checked-in constant). Claude ignores both. */
      model: z.string().min(1).optional(),
      pricing: z
        .object({
          models: z.record(
            z.object({
              inputPerMTok: z.number().nonnegative(),
              outputPerMTok: z.number().nonnegative(),
            }),
          ),
          default: z.string().min(1).optional(),
        })
        .optional(),
    }),
  })
  .refine((c) => c.claimTtlSec * 1000 > c.wallClockMs, {
    // HARD INVARIANT (S7): the claim TTL T must exceed the lap deadline W — else a legitimately long lap
    // outruns its own claim, ready() re-surfaces the item mid-run, a second runner's CAS succeeds, and the
    // loop DOUBLE-SHIPS (the wg-c34349377f81 hazard the claim layer exists to prevent). Fail-loud, not the operator's job.
    message:
      'claimTtlSec*1000 must exceed wallClockMs (T > W) — else a long lap outruns its claim → double-ship',
    path: ['claimTtlSec'],
  })
  .superRefine((c, ctx) => {
    // MHL.2 — the SEMANTIC "has an adapter" gate (mirrors dispatcher.ts:70-73). The enum above is the SYNTACTIC
    // gate; this reads the resolver's SSOT implemented-kind set (LAP_HARNESS_KINDS) so a future enum value with
    // NO shipped adapter is caught at LOAD, not at spawn. SSOT-backed — no second kind-list to drift.
    if (!LAP_HARNESS_KINDS.has(c.harness.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['harness', 'kind'],
        message:
          `harness.kind "${c.harness.kind}" has no lap adapter — implemented kinds: ` +
          `${[...LAP_HARNESS_KINDS].join(' | ')}. Add a LapHarness adapter (see lap_harness.ts) before configuring it.`,
      });
    }
  });
export type RalphConfigFile = z.infer<typeof RalphConfigFileSchema>;

export const ralphMdPath = (home: string = OPENSQUID_HOME()): string => join(home, 'RALPH.md');
export const ralphConfigPath = (home: string = OPENSQUID_HOME()): string =>
  join(home, 'ralph.config.json');

/** Sensible defaults — subscription mode (W-bounded), conservative caps. Overridable by the wizard. */
export function defaultRalphConfig(home: string = OPENSQUID_HOME()): RalphConfigFile {
  return {
    authMode: 'subscription',
    maxBudgetUsd: 10,
    claimTtlSec: 3600, // T = 1h claim TTL — MUST exceed wallClockMs (W = 30m deadline) per S7 (T > W)
    wallClockMs: 30 * 60 * 1000,
    // Retry cap: 3 supervised re-attempts per lap. Kept low deliberately — beyond a few, retries waste
    // budget/wall-clock on a lap that's structurally stuck rather than flaky (user call, 2026-06-28).
    maxRetries: 3,
    backoffBaseMs: 2000,
    // MHL.1 — explicit default kind; sandbox/askForApproval omitted for Claude. An existing config file
    // without `kind` still loads (the schema default fills it) → byte-compatible.
    harness: { cli: 'claude', ralphMdPath: ralphMdPath(home), kind: 'claude' },
  };
}

type WriteOutcome = 'created' | 'unchanged' | 'replaced';

/** Idempotent atomic write: identical → no-op; divergent → snapshot the old to `<path>.bak` then rename. */
async function idempotentWrite(path: string, content: string): Promise<WriteOutcome> {
  let existing: string | null = null;
  try {
    existing = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (existing === content) return 'unchanged';
  if (existing !== null) await writeFile(`${path}.bak`, existing); // last line of defense before overwrite
  await atomicWriteFile(path, content);
  return existing === null ? 'created' : 'replaced';
}

export interface RalphInstallResult {
  home: string;
  ralphMd: { path: string; outcome: WriteOutcome };
  config: { path: string; outcome: WriteOutcome };
}

/**
 * Install/refresh the RALPH.md directive + loop config. Idempotent + re-runnable (the wizard calls this);
 * a second run with the same inputs is a no-op diff. Merges `overrides` over the defaults.
 */
export async function installRalph(
  opts: {
    home?: string;
    overrides?: Partial<RalphConfigFile>;
  } = {},
): Promise<RalphInstallResult> {
  const home = opts.home ?? OPENSQUID_HOME();
  const config: RalphConfigFile = RalphConfigFileSchema.parse({
    ...defaultRalphConfig(home),
    ...opts.overrides,
    // a partial harness override must not drop the sibling field
    harness: { ...defaultRalphConfig(home).harness, ...opts.overrides?.harness },
  });
  const mdPath = ralphMdPath(home);
  const cfgPath = ralphConfigPath(home);
  const mdOutcome = await idempotentWrite(mdPath, RALPH_MD);
  const cfgOutcome = await idempotentWrite(cfgPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    home,
    ralphMd: { path: mdPath, outcome: mdOutcome },
    config: { path: cfgPath, outcome: cfgOutcome },
  };
}

/** Read + validate the loop config (fail-loud per the project Zod invariant). Null if absent (loop OFF). */
export async function readRalphConfig(
  home: string = OPENSQUID_HOME(),
): Promise<RalphConfigFile | null> {
  let raw: string;
  try {
    raw = await readFile(ralphConfigPath(home), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // not configured ⇒ loop OFF
    throw e;
  }
  return RalphConfigFileSchema.parse(JSON.parse(raw));
}
