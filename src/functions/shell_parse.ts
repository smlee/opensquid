/**
 * Quote-aware shell tokenizer + git-invocation predicate. Pure, deterministic, total.
 *
 * Backs the `command_invokes` event primitive (src/functions/event.ts), which gates on a
 * REAL git invocation instead of a raw-string match against the whole command — the
 * false-fire root cause (wg-52e57e2ed252: `git commit` inside a grep pattern / echo arg /
 * quoted subprocess prompt tripped the substring matcher).
 *
 * Threat model (load-bearing — pre-research §0): best-effort, honest-agent self-discipline,
 * NOT adversary-proof. An agent controls its own shell and could evade any in-session check;
 * the HARD boundary is the owned git pre-commit/pre-push hook reading the real staged diff.
 * So this handles the command forms an honest agent actually types (quotes, compound
 * `&&`/`||`/`|`/`;`, git globals `-C`/`-c`), not obfuscated evasion (command substitution,
 * heredocs) — those are out of scope here and caught at the commit boundary.
 *
 * Contrast with `isReadOnlyBash` (src/runtime/session_state.ts:146): that splitter is
 * quote-BLIND (`split(/\|\||&&|;|\|/)`), acceptable there because it is fail-closed and
 * additive. A gate's mis-split is the bug, so this tokenizer is quote-aware.
 *
 * Imported by: src/functions/event.ts (the `command_invokes` primitive).
 */

// Bound input length (DoS / step-cap hygiene; matches the expression-fn ~10k convention,
// src/runtime/evaluator/expression/functions.ts:16).
const MAX_LEN = 10_000;

// git global options that consume a SEPARATE following token. Parity with the existing
// matchers' `(?:-[cC]\s+\S+\s+)*` sub-pattern (precedent: execute-gate/skill.yaml:27) and
// git(1)'s `git [<options>] <command>` grammar. The full version-dependent separate-value
// global set (--git-dir <p>, --work-tree <p>, …) is DELIBERATELY not enumerated: an
// un-handled one yields only a rare false-NEGATIVE (its value mis-read as the subcommand),
// backstopped by the owned git hook for the phase gates — see the module header + §4.2.
const GIT_VALUE_GLOBALS = new Set(['-C', '-c']);

/**
 * Tokenize a shell command into segments (argv arrays), splitting on UNQUOTED control
 * operators (`&& || | ; & newline`) and UNQUOTED whitespace, stripping quotes. Single
 * quotes are literal; double quotes honor `\` escapes for `" \ $ ` (backtick); an unquoted
 * `\` escapes the next char. Returns `[]` for non-string / empty / over-long input.
 */
export function tokenizeShell(command: string): string[][] {
  if (typeof command !== 'string' || command.length === 0 || command.length > MAX_LEN) {
    return [];
  }
  const segments: string[][] = [];
  let argv: string[] = [];
  let word = '';
  let hasWord = false;
  let i = 0;
  let quote: "'" | '"' | null = null;
  const n = command.length;

  const endWord = (): void => {
    if (hasWord) {
      argv.push(word);
      word = '';
      hasWord = false;
    }
  };
  const endSeg = (): void => {
    endWord();
    if (argv.length > 0) {
      segments.push(argv);
      argv = [];
    }
  };

  while (i < n) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else {
        word += ch;
        hasWord = true;
      }
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        i++;
        continue;
      }
      if (ch === '\\' && i + 1 < n && '"\\$`'.includes(command[i + 1]!)) {
        word += command[i + 1];
        hasWord = true;
        i += 2;
        continue;
      }
      word += ch;
      hasWord = true;
      i++;
      continue;
    }
    // unquoted
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true; // an empty quoted string is still a (empty) word
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < n) {
      word += command[i + 1];
      hasWord = true;
      i += 2;
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      endSeg();
      i += 2;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      endSeg();
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      endSeg();
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord();
      i++;
      continue;
    }
    word += ch;
    hasWord = true;
    i++;
  }
  endSeg();
  return segments;
}

/** Basename of a program token (`/usr/bin/git` → `git`). */
function basename(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash === -1 ? p : p.slice(slash + 1);
}

/**
 * Is `flag` present in an invocation's args? Long `--f` = exact or `--f=…`; short `-x` =
 * exact or inside a pure short-flag cluster `-axb` (NOT a value-glued token). A literal
 * (neither `--` nor a 2-char `-x`) matches only exactly.
 */
function flagPresent(args: string[], flag: string): boolean {
  const isShort = flag.length === 2 && flag.startsWith('-') && /[A-Za-z]/.test(flag[1]!);
  for (const a of args) {
    if (flag.startsWith('--')) {
      if (a === flag || a.startsWith(flag + '=')) return true;
    } else if (isShort) {
      if (a === flag || (/^-[A-Za-z]+$/.test(a) && a.includes(flag[1]!))) return true;
    } else if (a === flag) {
      return true;
    }
  }
  return false;
}

export interface InvokeQuery {
  program: string;
  // `| undefined` (not just `?`) so callers under exactOptionalPropertyTypes can pass an
  // explicitly-undefined optional through (the primitive forwards Zod-optional fields).
  subcommand?: string | undefined;
  flagAny?: string[] | undefined;
  // wg-320845a92b65: exact-match a non-flag positional's refspec TARGET (dst of `src:dst`,
  // `+`-stripped, basename after `/`). Conjunctive with flagAny.
  argAny?: string[] | undefined;
}

/**
 * The branch TARGET a push positional refers to: the destination of a `src:dst` refspec (after
 * the LAST `:`), with a leading `+` force-modifier stripped and the basename taken after `/`.
 * `main:develop` → `develop`; `HEAD:main`/`+main`/`origin/main`/`refs/heads/main` → `main`;
 * `feature/main-x` → `main-x`; a token with no delimiter (npm's `minor`/`major`) → itself.
 */
function refTarget(a: string): string {
  const dst = a.includes(':') ? a.slice(a.lastIndexOf(':') + 1) : a;
  const noPlus = dst.startsWith('+') ? dst.slice(1) : dst;
  const slash = noPlus.lastIndexOf('/');
  return slash === -1 ? noPlus : noPlus.slice(slash + 1);
}

/**
 * True iff some real shell segment invokes `program` (basename match) AND — if `subcommand`
 * is given — its first positional (after skipping git global options and `-C`/`-c` values)
 * equals it AND — if `flagAny` is given — at least one listed flag is present in that
 * invocation's args.
 */
export function commandInvokes(command: string, q: InvokeQuery): boolean {
  for (const argv of tokenizeShell(command)) {
    if (argv.length === 0 || basename(argv[0]!) !== q.program) continue;
    if (q.subcommand === undefined) return true;
    // Resolve the subcommand: skip leading global options (and -C/-c separate values).
    let j = 1;
    while (j < argv.length && argv[j]!.startsWith('-')) {
      j += GIT_VALUE_GLOBALS.has(argv[j]!) ? 2 : 1;
    }
    if (j >= argv.length || argv[j] !== q.subcommand) continue;
    const rest = argv.slice(j + 1);
    // flagAny + argAny gate CONJUNCTIVELY (both must hold when both are given).
    if (q.flagAny !== undefined && !q.flagAny.some((f) => flagPresent(rest, f))) continue;
    if (q.argAny !== undefined) {
      const targets = rest.filter((a) => !a.startsWith('-')).map(refTarget);
      if (!q.argAny.some((v) => targets.includes(v))) continue;
    }
    return true;
  }
  return false;
}
