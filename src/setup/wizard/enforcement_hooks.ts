/**
 * T-multi-harness-enforce — wire opensquid's PreToolUse DENY hook into each blocking-capable harness's
 * own project config, so the discipline ENFORCES (not just advises) beyond claude-code + codex.
 *
 * All targeted harnesses honor a hook command's EXIT CODE 2 as "deny" (per the cited capability matrix,
 * docs/research/per-harness-capability-matrix.md), and opensquid's shipped `opensquid-hook-pretooluse`
 * bin exits 2 on a block. So each harness just registers that bin as a pre-execution hook in its own
 * config shape. Idempotent (an existing opensquid entry is not duplicated), foreign-preserving (a user's
 * own hooks are kept), `.bak` snapshot, atomic tmp+rename.
 *
 * SCOPE: the 6 JSON-config harnesses the matrix marks auto-writable. Amp/OpenCode/Cline need a TS plugin
 * or an executable script (not a JSON entry) — they are returned as `manual` for the caller to print, with
 * the snippet to paste. Caveats from the matrix are encoded: Cursor needs `failClosed:true` (else fails
 * OPEN); Windsurf has no JSON decision field (exit-2 only — which is exactly what the bin emits).
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/** The shipped bin every harness points at — it exits 2 on a blocked tool (the universal deny signal). */
const DENY_CMD = 'opensquid-hook-pretooluse';

type Json = Record<string, unknown>;

/**
 * One harness's enforcement target: where its hook config lives (project-relative) + a pure merge that adds
 * opensquid's deny hook into that harness's shape, preserving foreign content + staying idempotent.
 */
interface EnforcementTarget {
  harness: string;
  /** detect marker: the harness's project config dir (relative to project root). */
  detectDir: string;
  path: (projectRoot: string) => string;
  /** PURE: return `existing` (parsed JSON, or {}) with opensquid's deny hook merged in. Idempotent. */
  merge: (existing: Json) => Json;
}

/** Ensure `arr` (a list of {hooks:[{command}]} or {command} entries) carries opensquid's deny entry once. */
function ensureCommandHook(arr: unknown, entry: Json): Json[] {
  const list = Array.isArray(arr) ? (arr as Json[]) : [];
  const has = list.some((g) => JSON.stringify(g).includes(DENY_CMD));
  return has ? list : [...list, entry];
}

/** A Claude-Code-compatible `{matcher, hooks:[{type:command, command}]}` group. */
const cmdGroup: Json = { matcher: '', hooks: [{ type: 'command', command: DENY_CMD }] };

export const ENFORCEMENT_TARGETS: EnforcementTarget[] = [
  {
    harness: 'gemini',
    detectDir: '.gemini',
    path: (p) => join(p, '.gemini', 'settings.json'),
    merge: (e) => {
      const hooks = (e.hooks as Json) ?? {};
      return {
        ...e,
        hooks: { ...hooks, BeforeTool: ensureCommandHook(hooks.BeforeTool, cmdGroup) },
      };
    },
  },
  {
    harness: 'qwen',
    detectDir: '.qwen',
    path: (p) => join(p, '.qwen', 'settings.json'),
    merge: (e) => {
      const hooks = (e.hooks as Json) ?? {};
      return {
        ...e,
        hooks: { ...hooks, PreToolUse: ensureCommandHook(hooks.PreToolUse, cmdGroup) },
      };
    },
  },
  {
    harness: 'continue',
    detectDir: '.continue',
    path: (p) => join(p, '.continue', 'settings.json'),
    merge: (e) => {
      const hooks = (e.hooks as Json) ?? {};
      return {
        ...e,
        hooks: { ...hooks, PreToolUse: ensureCommandHook(hooks.PreToolUse, cmdGroup) },
      };
    },
  },
  {
    harness: 'trae',
    detectDir: '.trae',
    path: (p) => join(p, '.trae', 'hooks.json'),
    merge: (e) => {
      const hooks = (e.hooks as Json) ?? {};
      return {
        ...e,
        version: e.version ?? 1,
        hooks: { ...hooks, PreToolUse: ensureCommandHook(hooks.PreToolUse, cmdGroup) },
      };
    },
  },
  {
    harness: 'windsurf',
    detectDir: '.windsurf',
    path: (p) => join(p, '.windsurf', 'hooks.json'),
    // Windsurf: exit-2 only (no JSON field) — the bin's exit 2 IS the deny. Bare {command} entries.
    merge: (e) => {
      const hooks = (e.hooks as Json) ?? {};
      return {
        ...e,
        hooks: {
          ...hooks,
          pre_run_command: ensureCommandHook(hooks.pre_run_command, { command: DENY_CMD }),
          pre_mcp_tool_use: ensureCommandHook(hooks.pre_mcp_tool_use, { command: DENY_CMD }),
        },
      };
    },
  },
  {
    harness: 'cursor',
    detectDir: '.cursor',
    path: (p) => join(p, '.cursor', 'hooks.json'),
    // Cursor: MUST set failClosed:true (else a hook crash fails OPEN — matrix caveat).
    merge: (e) => {
      const hooks = (e.hooks as Json) ?? {};
      const entry: Json = { command: DENY_CMD, failClosed: true };
      return {
        ...e,
        version: e.version ?? 1,
        hooks: {
          ...hooks,
          beforeShellExecution: ensureCommandHook(hooks.beforeShellExecution, entry),
          beforeMCPExecution: ensureCommandHook(hooks.beforeMCPExecution, entry),
        },
      };
    },
  },
];

/** Harnesses that can block but need a TS plugin / executable script (not a JSON entry) — returned as manual. */
export const MANUAL_ENFORCEMENT: { harness: string; note: string }[] = [
  {
    harness: 'amp',
    note: `.amp/plugins/*.ts — amp.on('tool.call', …) returning {action:'reject-and-continue'} (shell out to ${DENY_CMD}; exit 2 ⇒ reject)`,
  },
  {
    harness: 'opencode',
    note: `.opencode/plugin/*.ts — "tool.execute.before" throwing on a ${DENY_CMD} exit-2`,
  },
  {
    harness: 'cline',
    note: `.clinerules/hooks/PreToolUse (chmod +x; macOS/Linux) — run ${DENY_CMD}; on exit 2 print {"cancel":true}`,
  },
];

export interface EnforcementReport {
  written: { harness: string; path: string; result: 'created' | 'updated' | 'unchanged' }[];
  manual: { harness: string; note: string }[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write opensquid's deny hook into every DETECTED harness's project config (a `detectDir` present under the
 * project root = installed-for-this-project). Idempotent + foreign-preserving + `.bak`. Returns the report;
 * the 3 plugin/script harnesses are returned as `manual`.
 */
export async function installEnforcementHooks(projectRoot: string): Promise<EnforcementReport> {
  const report: EnforcementReport = { written: [], manual: [] };

  for (const t of ENFORCEMENT_TARGETS) {
    if (!(await exists(join(projectRoot, t.detectDir)))) continue; // not used in this project → skip
    const path = t.path(projectRoot);
    let existing: Json = {};
    let had = false;
    try {
      existing = JSON.parse(await fs.readFile(path, 'utf8')) as Json;
      had = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const before = JSON.stringify(existing);
    const merged = t.merge(existing);
    const after = JSON.stringify(merged, null, 2);
    if (had && JSON.stringify(merged) === before) {
      report.written.push({ harness: t.harness, path, result: 'unchanged' });
      continue;
    }
    if (had) await fs.writeFile(`${path}.bak`, await fs.readFile(path, 'utf8'));
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, after);
    await fs.rename(tmp, path);
    report.written.push({ harness: t.harness, path, result: had ? 'updated' : 'created' });
  }

  // The 3 plugin/script harnesses: surface only if their dir is present (installed for this project).
  for (const m of MANUAL_ENFORCEMENT) {
    const dir = m.harness === 'cline' ? '.clinerules' : `.${m.harness}`;
    if (await exists(join(projectRoot, dir))) report.manual.push(m);
  }
  return report;
}
