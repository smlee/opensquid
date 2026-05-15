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

const HOOK_ID = "opensquid-drift-pretooluse";

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

function buildHookCommand(): string {
  return `node ${opensquidBinPath()} hook pre-tool-use`;
}

/** Remove any existing opensquid hook from a matcher list. */
function purgeOurHook(matchers: ClaudeMatcher[]): ClaudeMatcher[] {
  return matchers
    .map((m) => ({
      ...m,
      hooks: m.hooks.filter((h) => h._id !== HOOK_ID),
    }))
    .filter((m) => m.hooks.length > 0);
}

async function cmdInstall(): Promise<void> {
  const settings = await loadSettings();
  const hooks = settings.hooks ?? {};
  const existing = hooks.PreToolUse ?? [];
  const purged = purgeOurHook(existing);
  // Add our hook fresh — single matcher "Bash" (the only tool we
  // currently intercept; widen later as more patterns land).
  purged.push({
    matcher: "Bash",
    hooks: [
      {
        type: "command",
        command: buildHookCommand(),
        _id: HOOK_ID,
      },
    ],
  });
  settings.hooks = { ...hooks, PreToolUse: purged };
  await saveSettings(settings);
  console.log(`[opensquid hooks install] wrote ${settingsPath()}`);
  console.log(`  PreToolUse → ${buildHookCommand()}`);
  console.log(`  matcher:     Bash`);
  console.log(`  next: restart Claude Code so the new settings load.`);
}

async function cmdUninstall(): Promise<void> {
  const settings = await loadSettings();
  const hooks = settings.hooks;
  if (!hooks || !hooks.PreToolUse) {
    console.log(`[opensquid hooks uninstall] no PreToolUse hooks configured`);
    return;
  }
  const before = countOurHooks(hooks.PreToolUse);
  const purged = purgeOurHook(hooks.PreToolUse);
  if (purged.length === 0) {
    delete hooks.PreToolUse;
  } else {
    hooks.PreToolUse = purged;
  }
  await saveSettings(settings);
  console.log(`[opensquid hooks uninstall] removed ${before} opensquid hook(s)`);
}

async function cmdDoctor(): Promise<void> {
  const settings = await loadSettings();
  const preToolUse = settings.hooks?.PreToolUse ?? [];
  const ourCount = countOurHooks(preToolUse);
  console.log(`[opensquid hooks doctor]`);
  console.log(`  settings.json:   ${settingsPath()}`);
  console.log(`  PreToolUse total entries: ${preToolUse.length}`);
  console.log(`  opensquid hooks active:   ${ourCount}`);
  console.log(`  expected command:         ${buildHookCommand()}`);
  if (ourCount === 0) {
    console.log(`  hint: run \`opensquid hooks install\` to enable drift-detection.`);
  }
}

function countOurHooks(matchers: ClaudeMatcher[]): number {
  let n = 0;
  for (const m of matchers) {
    for (const h of m.hooks) {
      if (h._id === HOOK_ID) n++;
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
