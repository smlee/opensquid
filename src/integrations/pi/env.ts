import { isAbsolute } from 'node:path';

const SHA256_HEX = /^[a-f0-9]{64}$/;

export const PI_CLI_ENV = 'OPENSQUID_PI_CLI';
export const PI_ROLE_MANIFEST_PATH_ENV = 'OPENSQUID_PI_ROLE_MANIFEST_PATH';
export const PI_ROLE_MANIFEST_HASH_ENV = 'OPENSQUID_PI_ROLE_MANIFEST_HASH';
export const PI_SHELL_COMMAND_PREFIX_ENV = 'OPENSQUID_PI_SHELL_COMMAND_PREFIX';
export const PI_SHELL_PATH_ENV = 'OPENSQUID_PI_SHELL_PATH';
/** Internal marker for the model-free full-composition probe; production laps explicitly override it to `0`. */
export const PI_READINESS_PROBE_ENV = 'OPENSQUID_PI_READINESS_PROBE';
/** Parent lap's total deadline projected to every bounded executor loop. */
export const PI_EXECUTOR_WALL_CLOCK_MS_ENV = 'OPENSQUID_PI_EXECUTOR_WALL_CLOCK_MS';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export function readPiRoleManifestEnv(env: NodeJS.ProcessEnv): {
  manifestPath: string;
  manifestHash: string;
} {
  const manifestPath = nonEmpty(env[PI_ROLE_MANIFEST_PATH_ENV]);
  if (manifestPath === undefined || !isAbsolute(manifestPath)) {
    throw new Error(`Pi role manifest env ${PI_ROLE_MANIFEST_PATH_ENV} must be an absolute path`);
  }
  const manifestHash = nonEmpty(env[PI_ROLE_MANIFEST_HASH_ENV]);
  if (manifestHash === undefined || !SHA256_HEX.test(manifestHash)) {
    throw new Error(
      `Pi role manifest env ${PI_ROLE_MANIFEST_HASH_ENV} must be a 64-char sha256 hex`,
    );
  }
  return { manifestPath, manifestHash };
}

export function readPiExecutorWallClockMs(env: NodeJS.ProcessEnv, fallbackMs: number): number {
  const raw = nonEmpty(env[PI_EXECUTOR_WALL_CLOCK_MS_ENV]);
  if (raw === undefined) return fallbackMs;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${PI_EXECUTOR_WALL_CLOCK_MS_ENV} must be a positive safe integer`);
  }
  return value;
}

export function isSha256Hex(value: string | undefined): value is string {
  return value !== undefined && SHA256_HEX.test(value);
}
