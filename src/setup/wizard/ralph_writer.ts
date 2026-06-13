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
    /** Harness is a PARAMETER (Inv 10): the lap CLI + the RALPH.md path it reads. */
    harness: z.object({ cli: z.string().min(1), ralphMdPath: z.string().min(1) }),
  })
  .refine((c) => c.claimTtlSec * 1000 > c.wallClockMs, {
    // HARD INVARIANT (S7): the claim TTL T must exceed the lap deadline W — else a legitimately long lap
    // outruns its own claim, ready() re-surfaces the item mid-run, a second runner's CAS succeeds, and the
    // loop DOUBLE-SHIPS (the wg-c34349377f81 hazard the claim layer exists to prevent). Fail-loud, not the operator's job.
    message:
      'claimTtlSec*1000 must exceed wallClockMs (T > W) — else a long lap outruns its claim → double-ship',
    path: ['claimTtlSec'],
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
    maxRetries: 2,
    backoffBaseMs: 2000,
    harness: { cli: 'claude', ralphMdPath: ralphMdPath(home) },
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
