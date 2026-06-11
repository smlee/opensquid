/**
 * Sealed built-in denylist for the capability gate (AUTO.3).
 * Spec: the automation planning notes [not retained — this header is the authority] AUTO.3 risk callouts.
 *
 * Value-only constants file. Exports are `Object.freeze`d so a misbehaving
 * consumer can't monkey-patch at runtime (the audit constraint demands the
 * built-in denylist be sealed; no `BUILTIN_SHELL_DENY.push(...)` escape).
 *
 * Escape hatch: env var `OPENSQUID_TRUST_BUILTIN_DENY=0` disables the
 * entire built-in denylist at gate construction time. The gate snapshots
 * the env once in its constructor; it can't be flipped mid-session.
 *
 * Channel + binary built-in denies are empty by design — shell + path
 * cover the high-risk surface; channels/binaries are user-defined.
 *
 * Imported by: src/runtime/capability_gate.ts.
 */

// Shell-command denylist — regex matched against the raw command. Patterns
// are case-sensitive (POSIX commands are lowercase) and use `\s+` so
// tab/multi-space invocations still trip. No `^`/`$` anchors so substring
// matches fire (`cd /tmp && rm -rf /` triggers).

export const BUILTIN_SHELL_DENY: readonly RegExp[] = Object.freeze([
  // rm -rf at root: /, /*, /<anything>
  /\brm\s+-rf\s+\/(?:\s|$|\*)/,
  // rm -rf with --no-preserve-root (deliberate root wipe)
  /\brm\s+-rf\s+--no-preserve-root\b/,
  // Fork bomb — match the canonical :(){...}; structure
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // dd from /dev/{zero,random,urandom} to /dev/sd* (real disk wipe)
  /\bdd\s+(?:[^|;&]*\s+)?if=\/dev\/(?:zero|random|urandom)\s+(?:[^|;&]*\s+)?of=\/dev\/sd/,
  // Redirect > /dev/sd*
  />\s*\/dev\/sd[a-z]/,
  // World-writable chmod (777) including recursive
  /\bchmod\s+(?:-R\s+)?(?:[ugoa]*[=+]\s*)?(?:[ugoa]*7+\s|7{3,4}\s|7{3,4}$)/,
  // chmod 777 form
  /\bchmod\s+(?:-R\s+)?[0-7]?777\b/,
  // curl ... | sh|bash|zsh — pipe-to-shell installer pattern
  /\bcurl\s+[^|;&]+\|\s*(?:sh|bash|zsh)\b/,
  // wget ... | sh|bash|zsh
  /\bwget\s+[^|;&]+\|\s*(?:sh|bash|zsh)\b/,
  // eval $(...) — command substitution into eval
  /\beval\s+["']?\$\(/,
  // mkfs on /dev/sd* — filesystem-format-on-disk
  /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\/sd/,
  // shutdown / halt / poweroff / reboot — host-destructive
  /\b(?:shutdown|halt|poweroff|reboot)\s+(?:-[a-z]+\s+)*(?:now|0|-h\s+now)\b/,
] as const);

// Shell metacharacters the gate rejects unless the exact raw command is in
// the pack's allowlist (per AUTO.3 spec; SEC.4 ships full shell-quote argv
// parser). `|` included even though pipes are legitimate — gate can't tell
// `git log | head` (safe) from `curl | sh` (built-in deny) at this layer.

export const SHELL_METACHARACTERS: readonly string[] = Object.freeze([
  ';',
  '&&',
  '||',
  '`',
  '$(',
  '|',
  '>',
  '>>',
  '<(',
] as const);

// Path denylist — minimatch globs. `~/` is expanded by the gate to
// `os.homedir()` BEFORE matching, so we can use the literal `~/` here.

export const BUILTIN_PATH_DENY: readonly string[] = Object.freeze([
  '/etc/**',
  '/usr/**',
  '/bin/**',
  '/sbin/**',
  '/boot/**',
  '/System/**', // macOS protected
  '/Library/**', // macOS protected (user has ~/Library which is fine)
  '/dev/**',
  '/proc/**',
  '/sys/**',
  '~/.ssh/**',
  '~/.aws/credentials',
  '~/.aws/config',
  '~/.config/op/**', // 1Password CLI state
  '~/.kube/config',
  '~/.gnupg/**',
  '~/.docker/config.json',
] as const);
// NOTE: `/var/**` and `/private/**` are intentionally excluded — macOS
// tmpdir is `/var/folders/...` and `/private/var/folders/...`, both
// user-writable scratch space. High-risk subpaths within /var (log,
// run, spool) are rarely skill-write targets; packs can deny them.

// Channel + binary + subagent built-in denies stay empty — packs declare via
// `permissions.<cap>.deny:`. Frozen for sealed-module discipline.
export const BUILTIN_CHANNEL_DENY: readonly string[] = Object.freeze([] as const);
export const BUILTIN_BINARY_DENY: readonly string[] = Object.freeze([] as const);
export const BUILTIN_SUBAGENT_DENY: readonly string[] = Object.freeze([] as const);

// Env-var snapshot. Gate copies into its constructor so a mid-session env
// mutation can't flip policy under a running pack.
export function trustBuiltinDeny(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENSQUID_TRUST_BUILTIN_DENY !== '0';
}
