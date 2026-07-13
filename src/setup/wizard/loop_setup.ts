import { createDefaultPiHarnessRuntimeAssets } from '../../integrations/pi/runtime.js';
import type { HarnessKind, VerifiedPiRuntime } from '../../runtime/ralph/lap_harness.js';
import { OPENSQUID_HOME } from '../../runtime/paths.js';
import {
  updatePiModelSelection,
  type PiModelSelection,
} from '../../integrations/pi/user_settings.js';
import { writePiMcp } from './pi-mcp-writer.js';
import { writePiInteractiveProjector } from './pi-projector-writer.js';
import { installRalph, ralphMdPath, type RalphInstallResult } from './ralph_writer.js';

export interface LoopSetupResult {
  readonly harness: HarnessKind;
  readonly ralph: RalphInstallResult;
  readonly pi?: VerifiedPiRuntime;
}

export interface LoopSetupDeps {
  installRalph: typeof installRalph;
  writePiMcp: typeof writePiMcp;
  piReadiness(input: { cli: string; cwd: string }): Promise<VerifiedPiRuntime>;
  updatePiModelSelection: typeof updatePiModelSelection;
  writePiProjector: typeof writePiInteractiveProjector;
}

/**
 * Configure the loop through one SDK-level operation shared by CLI and future TUI/web adapters.
 *
 * Ralph configuration records harness/runtime policy only. Provider and model selection deliberately remain in
 * the selected harness's user settings; Pi readiness reports what Pi resolved without mutating that selection.
 */
export async function setupLoop(
  input: {
    harness: HarnessKind;
    cwd: string;
    cli?: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
    /** Explicit user choice; absent means inherit Pi's current settings without mutation. */
    piModel?: PiModelSelection;
  },
  deps?: LoopSetupDeps,
): Promise<LoopSetupResult> {
  const home = input.home ?? OPENSQUID_HOME();
  const cli = input.cli ?? input.harness;
  const runtime = createDefaultPiHarnessRuntimeAssets(
    input.env === undefined ? {} : { env: input.env },
  );
  const resolvedDeps: LoopSetupDeps =
    deps ??
    ({
      installRalph,
      writePiMcp,
      piReadiness: runtime.readiness,
      updatePiModelSelection,
      writePiProjector: writePiInteractiveProjector,
    } satisfies LoopSetupDeps);

  const installSelectedRalph = () =>
    resolvedDeps.installRalph({
      home,
      overrides: {
        harness: {
          kind: input.harness,
          cli,
          ralphMdPath: ralphMdPath(home),
        },
      },
    });

  if (input.harness !== 'pi') {
    const ralph = await installSelectedRalph();
    return { harness: input.harness, ralph };
  }

  if (input.piModel !== undefined) {
    await resolvedDeps.updatePiModelSelection({
      selection: input.piModel,
      cli,
      cwd: input.cwd,
      ...(input.env === undefined ? {} : { env: input.env }),
    });
  }
  await resolvedDeps.writePiProjector({
    projectorPath: runtime.projectorExtensionPath,
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  await resolvedDeps.writePiMcp({
    cli,
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  const pi = await resolvedDeps.piReadiness({ cli, cwd: input.cwd });
  // Select Pi in the production loop config only after every Pi asset and readiness check passed. A failed
  // setup may leave idempotent prepared assets, but never leaves a half-configured active harness.
  const ralph = await installSelectedRalph();
  return { harness: input.harness, ralph, pi };
}
