/**
 * `opensquid hooks <subcommand>` — Claude Code settings.json hooks
 * installer.
 *
 * Subcommands:
 *   install    — append the opensquid PreToolUse hook to
 *                ~/.claude/settings.json (idempotent — re-running
 *                refreshes the hook command pointer without disturbing
 *                other hooks)
 *   uninstall  — remove the opensquid PreToolUse hook
 *   doctor     — report what's currently installed
 *
 * The PreToolUse hook runs the local opensquid build's `hook
 * pre-tool-use` handler (see src/hooks/pre-tool-use.ts), which
 * intercepts known-anti-pattern actions (amend, push, substrate-impure
 * engine commits) before Claude Code executes them.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

export class HooksCliError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "HooksCliError";
  }
}

/**
 * Per-event opensquid hook id. Was a single shared id pre-#118, which
 * meant uninstall could not selectively target one event AND legacy
 * entries written by older opensquid versions never got recognized
 * (since they had a different id, or none at all).
 */
const HOOK_IDS = {
  PreToolUse: "opensquid-pre-tool-use",
  Stop: "opensquid-stop",
  UserPromptSubmit: "opensquid-user-prompt-submit",
  SessionEnd: "opensquid-session-end",
} as const;

/** Legacy id used through 2026-05-15 — purgeOurHook still recognizes it. */
const LEGACY_HOOK_ID = "opensquid-drift-pretooluse";

/**
 * Path-substring fallback that identifies opensquid hook entries even
 * when no `_id` marker is present (older installs, manual edits, etc.).
 * Matches anything that runs `opensquid/dist/index.js hook <event>`.
 */
const COMMAND_FINGERPRINT = "/opensquid/dist/index.js hook ";

interface ClaudeHook {
  type: "command";
  command: string;
  /** Custom non-standard marker so we can find our own hook later. */
  _id?: string;
}

interface ClaudeMatcher {
  matcher?: string;
  hooks: ClaudeHook[];
}

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: ClaudeMatcher[];
    [k: string]: ClaudeMatcher[] | undefined;
  };
  [k: string]: unknown;
}

function settingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

async function loadSettings(): Promise<ClaudeSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as ClaudeSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveSettings(settings: ClaudeSettings): Promise<void> {
  const p = settingsPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/** Absolute path to the opensquid CLI binary that hosts this code. */
function opensquidBinPath(): string {
  // import.meta.url points at dist/hooks-cli.js after build; the entry
  // point is dist/index.js in the same directory.
  const here = url.fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), "index.js");
}

function buildHookCommand(
  hookName: "pre-tool-use" | "stop" | "user-prompt-submit" | "session-end",
): string {
  return `node ${opensquidBinPath()} hook ${hookName}`;
}

/** True when a hook entry is recognizably opensquid's. */
export function isOurHook(h: ClaudeHook): boolean {
  if (h._id === LEGACY_HOOK_ID) return true;
  for (const id of Object.values(HOOK_IDS)) {
    if (h._id === id) return true;
  }
  // Fallback: command-path fingerprint catches un-marked legacy entries
  // that purgeOurHook used to silently skip (the bug from #118 dogfood).
  // Case-insensitive — macOS APFS default is case-preserving but case-
  // insensitive, so an install at /projects/OpenSquid/ should match too.
  if (
    typeof h.command === "string" &&
    h.command.toLowerCase().includes(COMMAND_FINGERPRINT.toLowerCase())
  ) {
    return true;
  }
  return false;
}

/** Remove any existing opensquid hook from a matcher list. */
function purgeOurHook(matchers: ClaudeMatcher[]): ClaudeMatcher[] {
  return matchers
    .map((m) => ({
      ...m,
      hooks: m.hooks.filter((h) => !isOurHook(h)),
    }))
    .filter((m) => m.hooks.length > 0);
}

async function cmdInstall(): Promise<void> {
  const settings = await loadSettings();
  const hooks = settings.hooks ?? {};

  // PreToolUse — single matcher ".*" is sufficient. It catches Bash
  // (drift checks live in pre-tool-use.ts handler keyed off tool_name)
  // AND every other tool (so the honesty ledger has full evidence for
  // Stop-hook reconciliation). Pre-#118 we registered TWO matchers
  // (Bash + .*) which double-fired on Bash and caused duplicate ledger
  // entries.
  const preToolUse = purgeOurHook(hooks.PreToolUse ?? []);
  preToolUse.push({
    matcher: ".*",
    hooks: [
      {
        type: "command",
        command: buildHookCommand("pre-tool-use"),
        _id: HOOK_IDS.PreToolUse,
      },
    ],
  });

  // Stop — claim-vs-action reconciliation + auto-classify spawn at turn end.
  const stop = purgeOurHook(hooks.Stop ?? []);
  stop.push({
    hooks: [{ type: "command", command: buildHookCommand("stop"), _id: HOOK_IDS.Stop }],
  });

  // UserPromptSubmit — surface previous turn's broken promises +
  // auto-classify candidates at the start of the next turn.
  const ups = purgeOurHook(hooks.UserPromptSubmit ?? []);
  ups.push({
    hooks: [
      {
        type: "command",
        command: buildHookCommand("user-prompt-submit"),
        _id: HOOK_IDS.UserPromptSubmit,
      },
    ],
  });

  // SessionEnd — clearSession to bound disk usage from per-session
  // ledger accumulation.
  const sessionEnd = purgeOurHook(hooks.SessionEnd ?? []);
  sessionEnd.push({
    hooks: [
      {
        type: "command",
        command: buildHookCommand("session-end"),
        _id: HOOK_IDS.SessionEnd,
      },
    ],
  });

  settings.hooks = {
    ...hooks,
    PreToolUse: preToolUse,
    Stop: stop,
    UserPromptSubmit: ups,
    SessionEnd: sessionEnd,
  };
  await saveSettings(settings);

  console.log(`[opensquid hooks install] wrote ${settingsPath()}`);
  console.log(`  PreToolUse       → ${buildHookCommand("pre-tool-use")}`);
  console.log(`  Stop             → ${buildHookCommand("stop")}`);
  console.log(`  UserPromptSubmit → ${buildHookCommand("user-prompt-submit")}`);
  console.log(`  SessionEnd       → ${buildHookCommand("session-end")}`);
  console.log(`  next: restart Claude Code so the new settings load.`);
}

async function cmdUninstall(): Promise<void> {
  const settings = await loadSettings();
  const hooks = settings.hooks;
  if (!hooks) {
    console.log(`[opensquid hooks uninstall] no hooks configured`);
    return;
  }
  let totalRemoved = 0;
  for (const event of ["PreToolUse", "Stop", "UserPromptSubmit", "SessionEnd"] as const) {
    const matchers = hooks[event];
    if (!matchers) continue;
    totalRemoved += countOurHooks(matchers);
    const purged = purgeOurHook(matchers);
    if (purged.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = purged;
    }
  }
  await saveSettings(settings);
  console.log(`[opensquid hooks uninstall] removed ${totalRemoved} opensquid hook(s)`);
}

async function cmdDoctor(): Promise<void> {
  const settings = await loadSettings();
  const hooks = settings.hooks ?? {};
  console.log(`[opensquid hooks doctor]`);
  console.log(`  settings.json: ${settingsPath()}`);
  for (const event of ["PreToolUse", "Stop", "UserPromptSubmit", "SessionEnd"] as const) {
    const matchers = hooks[event] ?? [];
    const ours = countOurHooks(matchers);
    console.log(`  ${event.padEnd(18)} total=${matchers.length}  opensquid=${ours}`);
  }
}

function countOurHooks(matchers: ClaudeMatcher[]): number {
  let n = 0;
  for (const m of matchers) {
    for (const h of m.hooks) {
      if (isOurHook(h)) n++;
    }
  }
  return n;
}

export type HooksCliCmd = "install" | "uninstall" | "doctor";

export async function runHooksCli(cmd: HooksCliCmd, _argv: string[]): Promise<void> {
  switch (cmd) {
    case "install":
      await cmdInstall();
      return;
    case "uninstall":
      await cmdUninstall();
      return;
    case "doctor":
      await cmdDoctor();
      return;
  }
}
