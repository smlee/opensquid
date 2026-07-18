/** Neutral lap-harness contract and adapter registry. */
import { claudeLapHarness } from './harnesses/claude_lap_harness.js';
import { codexLapHarness } from './harnesses/codex_lap_harness.js';
import { piLapHarness } from './harnesses/pi_lap_harness.js';
import type { runOneShotCli } from '../spawn_lifecycle.js';
import type { runStreamingCli } from '../streaming_cli.js';
import type { CodexApprovalPolicy, CodexSandboxMode } from './harnesses/codex_lap_harness.js';

export type HarnessKind = 'claude' | 'codex' | 'pi';

export interface ModelPricing {
  models: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
  default?: string | undefined;
}
/** Backward-compatible type name retained for callers that price a one-shot adapter. */
export type CodexPricing = ModelPricing;

interface HarnessConfigBase {
  cli: string;
  ralphMdPath: string;
  maxBudgetUsd: number;
}

export type ClaudeHarnessConfig = HarnessConfigBase & { kind: 'claude' };
export type CodexHarnessConfig = HarnessConfigBase & {
  kind: 'codex';
  sandbox?: CodexSandboxMode | undefined;
  askForApproval?: CodexApprovalPolicy | undefined;
  model?: string | undefined;
  pricing?: ModelPricing | undefined;
};
export type PiHarnessConfig = HarnessConfigBase & {
  kind: 'pi';
};
export type HarnessConfig = ClaudeHarnessConfig | CodexHarnessConfig | PiHarnessConfig;

/** Compatibility-only helper shape for pure vendor parser/pricing functions. Runtime and persisted config use HarnessConfig. */
export interface LapHarnessCfg {
  maxBudgetUsd: number;
  sandbox?: CodexSandboxMode | undefined;
  askForApproval?: CodexApprovalPolicy | undefined;
  model?: string | undefined;
  pricing?: ModelPricing | undefined;
}

export interface CoreControlOutcome {
  /** Core-generated only; model-authored RALPH tags cannot produce either value. */
  readonly kind: 'PROCESS_PAUSED' | 'CANCELLED_BY_HUMAN';
  readonly processId: string;
  readonly action: 'graceful_stop' | 'terminate' | 'force_kill';
  readonly actionId: string;
}

export interface LapEnvelope {
  resultText: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Present when the harness reports cache-specific usage separately. */
  cacheReadTokens?: number;
  /** Present when the harness reports cache-specific usage separately. */
  cacheWriteTokens?: number;
  /** Trusted harness/core channel; never parsed from model text. */
  controlOutcome?: CoreControlOutcome;
  isError: boolean;
}

export interface LapRequest {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  attemptId: string;
  onStderrLine?: (line: string) => void;
  onStreams?: (streams: { stdout: string; stderr: string; code: number | null }) => void;
}

/**
 * Evidence produced by setup/readiness (Slice 2) and consumed fail-closed here.
 * The interface is intentionally data-only so setup, probes and later full-runtime
 * stage-runtime composition can implement it without importing the lap adapter. `registeredTools`
 * proves the runtime registered the StageProcess tool surface; `activeTools` proves those
 * tools are actually live.
 */
export interface VerifiedPiRuntime {
  readonly piVersion: string;
  readonly mcpAdapterVersion: string;
  readonly providers: ReadonlyMap<string, ReadonlySet<string> | null>;
  /** Provider/model Pi itself resolved from the user's settings. OpenSquid does not select either. */
  readonly resolvedModel: Readonly<{ provider: string; id: string }>;
  readonly registeredTools: ReadonlySet<string>;
  readonly activeTools: ReadonlySet<string>;
  readonly genericProxyAbsent: boolean;
  readonly effectiveShell: Readonly<{
    commandPrefix?: string;
    shellPath?: string;
  }>;
}

export interface PiHarnessRuntimeAssets {
  readonly systemPromptPath: string;
  readonly mcpAdapterExtensionPath: string;
  readonly projectorExtensionPath: string;
  readonly stageTools: readonly string[];
  readonly statsTimeoutMs?: number;
  /** Must validate merged config/bootstrap/probe before returning evidence. */
  readonly readiness: (input: {
    cli: string;
    cwd: string;
    /** Per-lap identity used only to register readiness subprocesses with the shared control plane. */
    env?: NodeJS.ProcessEnv;
    attemptId?: string;
  }) => Promise<VerifiedPiRuntime>;
}

/** `null` is an explicit not-composed state, never a production readiness stub. */
export interface HarnessRuntimeAssets {
  readonly pi: PiHarnessRuntimeAssets | null;
}

export interface LapRuntimeDeps {
  runOneShot: typeof runOneShotCli;
  runStreaming: typeof runStreamingCli;
  assets: HarnessRuntimeAssets;
}

export interface LapHarness<C extends HarnessConfig = HarnessConfig> {
  readonly kind: C['kind'];
  run(request: LapRequest, config: C, deps: LapRuntimeDeps): Promise<LapEnvelope>;
  preflight?(config: C, deps: LapRuntimeDeps, request: LapRequest): Promise<void>;
}

export const LAP_HARNESS_KINDS: ReadonlySet<HarnessKind> = new Set(['claude', 'codex', 'pi']);

export function resolveLapHarness(kind: 'claude'): LapHarness<ClaudeHarnessConfig>;
export function resolveLapHarness(kind: 'codex'): LapHarness<CodexHarnessConfig>;
export function resolveLapHarness(kind: 'pi'): LapHarness<PiHarnessConfig>;
export function resolveLapHarness(kind: HarnessKind): LapHarness;
export function resolveLapHarness(kind: HarnessKind): LapHarness {
  switch (kind) {
    case 'claude':
      return claudeLapHarness;
    case 'codex':
      return codexLapHarness;
    case 'pi':
      return piLapHarness;
    default:
      throw new Error(
        `No LapHarness adapter for harness.kind "${String(kind)}" — implemented: ${[...LAP_HARNESS_KINDS].join(' | ')}`,
      );
  }
}
