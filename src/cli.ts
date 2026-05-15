/**
 * `npx opensquid <subcommand>` — CLAUDE.md installer + maintenance.
 *
 * Subcommands:
 *   install     — write/refresh the opensquid automation block in CLAUDE.md
 *   uninstall   — strip the automation block, leave the rest intact
 *   doctor      — report what's installed, where, which version
 *
 * Flags:
 *   --project   — target `./CLAUDE.md` instead of `~/.claude/CLAUDE.md`
 *
 * Design invariants:
 *   - Sentinel-bracketed block (`<!-- opensquid-automation:start vX -->`
 *     ... `<!-- opensquid-automation:end -->`) so re-install is
 *     idempotent and uninstall is exact.
 *   - DETECT, DON'T REPLACE: existing CLAUDE.md content is preserved.
 *     If the target has no sentinel, we APPEND our block; we never
 *     rewrite content outside the sentinels.
 *   - Same version on re-install → no-op (just log "already at vX").
 *   - Different version on re-install → swap content between sentinels.
 *
 * The block text mirrors the wedge invariant:
 *   - recall + memorize are agent-side discretion (auto-callable);
 *   - remember + promote + eliminate need explicit user intent.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const BLOCK_VERSION = "v0.4.0";
const SENTINEL_START_PREFIX = "<!-- opensquid-automation:start ";
const SENTINEL_END = "<!-- opensquid-automation:end -->";
const RULES_SENTINEL_START = "<!-- opensquid-rules:start (auto-managed) -->";
const RULES_SENTINEL_END = "<!-- opensquid-rules:end -->";

/**
 * The body of the automation block (between sentinels).
 *
 * Three concerns layered in:
 *   1. Active recall (drift defense)
 *   2. Auto-observation: classify user utterances → silent memorize +
 *      surface promote-to-lesson offers
 *   3. Auto-managed rules sub-block — opensquid runtime appends one
 *      line per promoted lesson here; agent treats them as always-on
 *      rules.
 *
 * Keep this dense — every line lives in every turn's system prompt.
 */
function blockBody(): string {
  return [
    "## opensquid — memory + lesson layer for this agent",
    "",
    "**Before answering substantive questions**, call `recall`. Your in-",
    "context memory drifts after ~10 unrelated turns; recall re-anchors.",
    "",
    "**When the user says something, classify and act**:",
    "",
    '- Fact / observation ("X is the case", "I use Y", "Z is my kid") →',
    "  call `memorize` with the fact. Note the memory id in your reply.",
    '- Preference / directive ("always X", "never Y", "I prefer Z") →',
    "  call `memorize` AND `remember` (create a lesson candidate). Reply:",
    '  "Captured as a candidate rule — promote to permanent?"',
    '- Correction ("no, that\'s wrong", "actually it should be X") →',
    "  call `memorize` with the correction. If it supersedes a specific",
    "  prior memory you can identify, also call `update_memory`.",
    '- Workflow lock ("the workflow is X→Y→Z", "no hedges", "always pre-',
    '  research first") → same as preference: `memorize` + `remember` +',
    "  offer promote.",
    "",
    "**Never auto-call `promote` or `eliminate`** — these need explicit",
    "user intent (the wedge invariant). Surface offers; wait for OK.",
    "",
    "**Within `recall` results**, treat lessons as prescriptive rules and",
    "memories as background context. Apply lesson rules; cite memories.",
    "",
    "### Active lessons (auto-managed — do not edit by hand)",
    "",
    RULES_SENTINEL_START,
    "(no promoted lessons yet — this block populates as `lesson.promote`",
    "succeeds for user-endorsed candidates)",
    RULES_SENTINEL_END,
  ].join("\n");
}

function fullBlock(version: string = BLOCK_VERSION): string {
  return [`${SENTINEL_START_PREFIX}${version} -->`, blockBody(), SENTINEL_END].join("\n");
}

function targetPath(argv: string[]): string {
  if (argv.includes("--project")) {
    return path.resolve(process.cwd(), "CLAUDE.md");
  }
  return path.join(os.homedir(), ".claude", "CLAUDE.md");
}

interface ParsedBlock {
  /** The sentinel-marked region, including the start/end lines. */
  raw: string;
  /** The version string after `start ` (e.g. "v0.3.1"). */
  version: string;
  /** Character indices into the source text for `raw`. */
  start: number;
  end: number;
}

/**
 * Locate the opensquid block in `content`. Returns `null` if not found.
 * Tolerant of trailing whitespace on either sentinel line.
 */
function findBlock(content: string): ParsedBlock | null {
  const startMatch = content.match(/<!-- opensquid-automation:start ([^\s>]+) -->/);
  if (!startMatch || startMatch.index === undefined) return null;
  const startIdx = startMatch.index;
  const endMatch = content.indexOf(SENTINEL_END, startIdx);
  if (endMatch === -1) return null;
  const endIdx = endMatch + SENTINEL_END.length;
  return {
    raw: content.slice(startIdx, endIdx),
    version: startMatch[1],
    start: startIdx,
    end: endIdx,
  };
}

/** Append (or update) the automation block in `original`. */
function applyBlock(original: string): string {
  const existing = findBlock(original);
  const block = fullBlock();
  if (!existing) {
    // Append, ensuring a blank-line separator from prior content.
    if (original.length === 0) return `${block}\n`;
    const sep = original.endsWith("\n\n") ? "" : original.endsWith("\n") ? "\n" : "\n\n";
    return `${original}${sep}${block}\n`;
  }
  // Replace existing block in place.
  return `${original.slice(0, existing.start)}${block}${original.slice(existing.end)}`;
}

/** Strip the automation block from `original`. */
function stripBlock(original: string): string {
  const existing = findBlock(original);
  if (!existing) return original;
  // Also swallow surrounding newlines so we don't leave a hole.
  let start = existing.start;
  let end = existing.end;
  while (start > 0 && original[start - 1] === "\n") start--;
  while (end < original.length && original[end] === "\n") end++;
  const left = original.slice(0, start);
  const right = original.slice(end);
  if (left.length > 0 && right.length > 0) {
    return `${left}\n\n${right}`;
  }
  return `${left}${right}`;
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function doInstall(target: string): Promise<void> {
  const existing = await readIfExists(target);
  if (existing === null) {
    await ensureParentDir(target);
    await fs.writeFile(target, fullBlock() + "\n", "utf8");
    console.log(`[opensquid install] created ${target} with ${BLOCK_VERSION} block`);
    return;
  }
  const parsed = findBlock(existing);
  if (parsed && parsed.version === BLOCK_VERSION) {
    console.log(`[opensquid install] ${target} already has ${BLOCK_VERSION} block — no-op`);
    return;
  }
  const next = applyBlock(existing);
  await fs.writeFile(target, next, "utf8");
  if (parsed) {
    console.log(
      `[opensquid install] updated block in ${target}: ${parsed.version} → ${BLOCK_VERSION}`,
    );
  } else {
    console.log(`[opensquid install] appended ${BLOCK_VERSION} block to ${target}`);
  }
}

async function doUninstall(target: string): Promise<void> {
  const existing = await readIfExists(target);
  if (existing === null) {
    console.log(`[opensquid uninstall] ${target} not found — nothing to do`);
    return;
  }
  const parsed = findBlock(existing);
  if (!parsed) {
    console.log(`[opensquid uninstall] no opensquid block in ${target} — no-op`);
    return;
  }
  const next = stripBlock(existing);
  await fs.writeFile(target, next, "utf8");
  console.log(`[opensquid uninstall] stripped ${parsed.version} block from ${target}`);
}

async function doDoctor(target: string): Promise<void> {
  const existing = await readIfExists(target);
  if (existing === null) {
    console.log(`[opensquid doctor] target: ${target}`);
    console.log(`  status:  not found`);
    console.log(`  expected version: ${BLOCK_VERSION}`);
    return;
  }
  const parsed = findBlock(existing);
  console.log(`[opensquid doctor] target: ${target}`);
  console.log(`  size:    ${existing.length} bytes`);
  if (!parsed) {
    console.log(`  status:  file present, no opensquid block`);
    console.log(`  expected version: ${BLOCK_VERSION}`);
  } else {
    const matches = parsed.version === BLOCK_VERSION;
    console.log(`  status:  installed (${matches ? "current" : "outdated"})`);
    console.log(`  installed: ${parsed.version}`);
    console.log(`  expected:  ${BLOCK_VERSION}`);
    if (!matches) {
      console.log(`  hint: run \`opensquid install\` to refresh.`);
    }
  }
}

export async function runCli(
  cmd: "install" | "uninstall" | "doctor",
  argv: string[],
): Promise<void> {
  const target = targetPath(argv);
  switch (cmd) {
    case "install":
      await doInstall(target);
      return;
    case "uninstall":
      await doUninstall(target);
      return;
    case "doctor":
      await doDoctor(target);
      return;
  }
}
