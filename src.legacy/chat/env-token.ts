/**
 * Telegram / Discord / Slack bot-token loading from env var + .env
 * file (0.7.5+, #148).
 *
 * Priority (highest first):
 *   1. process.env.OPENSQUID_TELEGRAM_BOT_TOKEN (or _DISCORD_, _SLACK_)
 *   2. .env file (first match wins):
 *      - $OPENSQUID_ENV_FILE
 *      - ~/.loop/.env
 *      - ~/.opensquid/.env
 *      - <cwd>/.env
 *   3. ~/.opensquid/config.json chat_connections.<platform>.bot_token
 *
 * The .env parser supports standard KEY=VALUE lines AND a tolerant
 * "bare token" fallback (single non-comment line, no `=`) — the user
 * may save just the token. Bare tokens are treated as
 * OPENSQUID_TELEGRAM_BOT_TOKEN.
 *
 * NEVER logs the token value. Only logs which SOURCE the active token
 * came from, so operators can debug "which bot is this daemon
 * actually using" without leaking the secret.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type EnvKey =
  | "OPENSQUID_TELEGRAM_BOT_TOKEN"
  | "OPENSQUID_DISCORD_BOT_TOKEN"
  | "OPENSQUID_SLACK_BOT_TOKEN"
  | "OPENSQUID_SLACK_APP_TOKEN";

export type EnvSource = "env" | "env-file" | "config-json" | "missing";

export interface TokenLookup {
  value: string | undefined;
  source: EnvSource;
  /** Path to the .env file used (only set when source === "env-file"). */
  env_file_path?: string;
}

/** In-memory cache for parsed .env files. Invalidated on each new process. */
let envFileCache: { path: string; parsed: Record<string, string> } | null = null;

/**
 * Resolve a token by priority: process.env → .env file → config.json
 * fallback (caller-supplied). Returns the value AND the source it
 * came from so the caller can log the source without exposing the
 * value.
 */
export async function resolveToken(
  key: EnvKey,
  configJsonFallback: string | undefined,
): Promise<TokenLookup> {
  // 1. process.env
  const envVal = process.env[key];
  if (envVal && envVal.trim()) {
    return { value: envVal.trim(), source: "env" };
  }

  // 2. .env file
  const envFile = await locateEnvFile();
  if (envFile) {
    const parsed = await loadEnvFile(envFile);
    const fileVal = parsed[key];
    if (fileVal && fileVal.trim()) {
      return { value: fileVal.trim(), source: "env-file", env_file_path: envFile };
    }
  }

  // 3. config.json fallback
  if (configJsonFallback && configJsonFallback.trim()) {
    return { value: configJsonFallback.trim(), source: "config-json" };
  }

  return { value: undefined, source: "missing" };
}

/**
 * Find the first existing .env file in the search order. Returns null
 * if none exist.
 */
export async function locateEnvFile(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.OPENSQUID_ENV_FILE) candidates.push(process.env.OPENSQUID_ENV_FILE);
  const home = os.homedir();
  candidates.push(path.join(home, ".loop", ".env"));
  candidates.push(path.join(home, ".opensquid", ".env"));
  candidates.push(path.join(process.cwd(), ".env"));

  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      // not present, keep looking
    }
  }
  return null;
}

/**
 * Parse a .env file into a flat string map. Supports:
 *
 *   - `KEY=VALUE` lines (standard dotenv format)
 *   - `KEY="quoted value"` (double-quoted)
 *   - `KEY='quoted value'` (single-quoted)
 *   - `#` comments + blank lines
 *   - Bare-token fallback: if the file has exactly ONE non-comment
 *     line and that line has no `=`, treat it as
 *     OPENSQUID_TELEGRAM_BOT_TOKEN (most common shape for "user
 *     saved just the token")
 *
 * Caches by path to avoid re-reading on every call.
 */
export async function loadEnvFile(envPath: string): Promise<Record<string, string>> {
  if (envFileCache && envFileCache.path === envPath) {
    return envFileCache.parsed;
  }
  const raw = await fs.readFile(envPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const out: Record<string, string> = {};
  const nonComment: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    nonComment.push(trimmed);
  }
  let hadKeyValue = false;
  for (const line of nonComment) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    hadKeyValue = true;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes (single or double).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  // Bare-token fallback: exactly one non-comment line, no =, looks
  // like a Telegram bot token. Treat as OPENSQUID_TELEGRAM_BOT_TOKEN.
  if (!hadKeyValue && nonComment.length === 1) {
    const bare = nonComment[0];
    // Telegram tokens look like <digits>:<alphanum_-> (47+ chars total).
    if (/^\d+:[A-Za-z0-9_-]{20,}$/.test(bare)) {
      out.OPENSQUID_TELEGRAM_BOT_TOKEN = bare;
    }
  }
  envFileCache = { path: envPath, parsed: out };
  return out;
}

/** Test-only: clear the .env cache so subsequent loads re-read disk. */
export function _clearEnvFileCache(): void {
  envFileCache = null;
}
