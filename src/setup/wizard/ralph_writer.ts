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
import { basename, join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../../runtime/atomic_write.js';
import { OPENSQUID_HOME } from '../../runtime/paths.js';
import { RALPH_MD } from '../../runtime/ralph/ralph_template.js';
import { LAP_HARNESS_KINDS, type HarnessKind } from '../../runtime/ralph/lap_harness.js';
// The Codex approval/sandbox SSOT value types are homed in the Codex adapter (MHL.8 keeps vendor value literals
// out of the neutral lap_harness.ts seam). The config schema is neutrality-exempt, so the value tuples live here.
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
} from '../../runtime/ralph/harnesses/codex_lap_harness.js';

/** SSOT: the schema enum's members ARE the resolver's HarnessKind — `satisfies` is a compile-time drift guard
 *  (adding a kind here that the resolver's HarnessKind doesn't know is a type error, and vice-versa via the enum). */
const HARNESS_KINDS = ['claude', 'codex', 'pi'] as const satisfies readonly HarnessKind[];

const CODEX_APPROVAL_POLICIES = [
  'untrusted',
  'on-request',
  'never',
] as const satisfies readonly CodexApprovalPolicy[];
const CODEX_SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const satisfies readonly CodexSandboxMode[];

const HarnessBaseShape = {
  cli: z.string().min(1),
  ralphMdPath: z.string().min(1),
};
const PersistedHarnessSchema = z.preprocess(
  (value) => {
    if (value === null || typeof value !== 'object' || 'kind' in value) return value;
    return { ...(value as Record<string, unknown>), kind: 'claude' };
  },
  z.discriminatedUnion('kind', [
    z
      .object({
        ...HarnessBaseShape,
        kind: z.literal('claude'),
      })
      .strict(),
    z
      .object({
        ...HarnessBaseShape,
        kind: z.literal('codex'),
        sandbox: z.enum(CODEX_SANDBOX_MODES).optional(),
        askForApproval: z.enum(CODEX_APPROVAL_POLICIES).optional(),
      })
      .strict(),
    z
      .object({
        ...HarnessBaseShape,
        kind: z.literal('pi'),
      })
      .strict(),
  ]),
);

export const RalphConfigFileSchema = z
  .object({
    authMode: z.enum(['api', 'subscription']),
    maxBudgetUsd: z.number().positive(),
    claimTtlSec: z.number().int().positive(),
    wallClockMs: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    backoffBaseMs: z.number().int().positive(),
    harness: PersistedHarnessSchema,
  })
  .refine((config) => config.claimTtlSec * 1000 > config.wallClockMs, {
    message:
      'claimTtlSec*1000 must exceed wallClockMs (T > W) — else a long lap outruns its claim → double-ship',
    path: ['claimTtlSec'],
  })
  .superRefine((config, ctx) => {
    if (!HARNESS_KINDS.includes(config.harness.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['harness', 'kind'],
        message: `harness.kind "${config.harness.kind}" has no lap adapter`,
      });
    }
    const cliBase = basename(config.harness.cli);
    if (
      (LAP_HARNESS_KINDS as ReadonlySet<string>).has(cliBase) &&
      cliBase !== config.harness.kind
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['harness', 'cli'],
        message:
          `harness.cli "${config.harness.cli}" resolves to the "${cliBase}" harness binary but ` +
          `harness.kind is "${config.harness.kind}"`,
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
