/**
 * T-PORTABILITY POR.1 — `opensquid export` / `import` / `rebuild`.
 *
 * Roadmap stage ②: migration-grade whole-home portability. The bundle carries
 * TRUTH ONLY (the files-are-truth / projections-rebuild split the local-first
 * design already guarantees): everything under `~/.opensquid/` EXCEPT the
 * denylist below is exported by default (fail-portable for future truth
 * stores); the sqlite projections are rebuilt on import via the existing
 * idempotent entries.
 *
 * SECRETS (engineered, not assumed — a live bot_token was found in the export
 * set during design review): the catalogued credential fields in config.json
 * are REDACTED in the bundled copy (the live file is never touched), and a
 * fail-closed key-name scan over every bundled JSON/YAML REFUSES the export
 * on any uncatalogued secret-shaped value. Scope: structured config only —
 * user-authored .md/inbox content is not scanned (stated in the summary).
 *
 * IMPORT REFUSALS (different override semantics, by design): a lived-in home
 * refuses with NO override (no-silent-mutation; merge is v2); a newer-version
 * bundle refuses unless --force (forward-parse tolerance is unproven).
 * Rebuild failure never deletes extracted truth — the exact re-run commands
 * print (all three are real verbs: migrate-memories, migrate-lessons, and
 * the `rebuild` verb shipped here).
 *
 * Imports from: commander, node:fs(/promises), node:os, node:path, tar,
 *   ../../rag/migrate_memories.js, ../../rag/wedge/migrate.js,
 *   ../../workgraph/store.js, ../../rag/embedders/fastembed.js, yaml.
 * Imported by: src/cli.ts.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import type { Command } from 'commander';
import * as tar from 'tar';
import { parse as parseYaml } from 'yaml';

import { fastembedEmbedder } from '../../rag/embedders/fastembed.js';
import { migrateMemories } from '../../rag/migrate_memories.js';
import { migrateWedgeLessons } from '../../rag/wedge/migrate.js';
import { OPENSQUID_HOME, resolveLocalStoreDir } from '../../runtime/paths.js';
import { rebuildWorkGraph } from '../../workgraph/store.js';

// ---------------------------------------------------------------------------
// The denylist: machine-local + projections. Everything ELSE is truth by
// default (a future truth store exports automatically; the state-formats.md
// review gates BOTH lists in one place).
// ---------------------------------------------------------------------------
const EXCLUDE_PATTERNS: RegExp[] = [
  /^sessions(\/|$)/,
  /^rag\.sqlite/,
  /^workgraph\.db/,
  /^wg_lessons\.db/,
  /\.(sock|pid|log)$/,
  /\.bak[^/]*$/,
  /^memories\.bak-/,
  /^loop-engine\./,
  /^umbrellas\/[^/]+\/live-session\.lease$/,
  /^memories\/[^/]+\.vec$/,
  // The fastembed model cache: a multi-MB downloaded artifact, re-fetched on
  // first use — machine-local, never truth (live-spike catch: its tokenizer
  // configs also tripped the secret scan's old substring match).
  /^models(\/|$)/,
];
export function isExcluded(rel: string): boolean {
  return EXCLUDE_PATTERNS.some((p) => p.test(rel));
}

/** Bundle entries shaped like projections/runtime state get a WARN-and-skip
 *  on import (the symmetric denylist failure: belt and braces). */
const PROJECTION_SHAPED = /\.(db|sqlite|sock|pid)$/;

// ---------------------------------------------------------------------------
// Secrets: catalogued redaction + fail-closed scan.
// ---------------------------------------------------------------------------

/** Redact the catalogued credential fields (channels/config.ts schema:
 *  chat_connections.<platform>.bot_token|app_token). Pure — operates on the
 *  parsed copy bound for the bundle; the live file is never modified. */
export function redactConfig(parsed: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(parsed);
  const conns = (out.chat_connections ?? {}) as Record<string, Record<string, unknown>>;
  for (const platform of Object.values(conns)) {
    if (platform === null || typeof platform !== 'object') continue;
    for (const field of ['bot_token', 'app_token']) {
      if (typeof platform[field] === 'string' && platform[field] !== '') {
        platform[field] = '<redacted-on-export>';
      }
    }
  }
  return out;
}

// Word-precise: `token` must not match `tokenizer_*` (the live spike's false
// positive); match key names that ARE or END IN the credential word.
const SECRET_KEY = /(^|_)(token|secret|password|api_?key)$/i;

/** Fail-closed: any uncatalogued secret-shaped value in structured config
 *  refuses the export, naming the exact path. `env:` URIs and the redaction
 *  marker are exempt. */
export function scanForSecrets(rel: string, parsed: unknown, path = ''): string[] {
  const hits: string[] = [];
  if (Array.isArray(parsed)) {
    parsed.forEach((v, i) => hits.push(...scanForSecrets(rel, v, `${path}${String(i)}.`)));
  } else if (parsed !== null && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        SECRET_KEY.test(k) &&
        typeof v === 'string' &&
        v.length > 8 &&
        !v.startsWith('env:') &&
        v !== '<redacted-on-export>'
      ) {
        hits.push(`${rel}: ${path}${k}`);
      } else {
        hits.push(...scanForSecrets(rel, v, `${path}${k}.`));
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Walk + manifest.
// ---------------------------------------------------------------------------

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join('/');
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) await walk(full, root, out);
    else if (entry.isFile()) out.push(rel);
  }
}

/** The truth file list for a home (denylist applied). */
export async function buildExportList(homeDir: string): Promise<string[]> {
  const out: string[] = [];
  await walk(homeDir, homeDir, out);
  return out.sort();
}

interface Manifest {
  version: 1;
  opensquid: string;
  created_at: string;
  files: number;
}

async function localVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ---------------------------------------------------------------------------
// Export.
// ---------------------------------------------------------------------------

export async function runExport(opts: {
  homeDir?: string;
  out?: string;
  dryRun?: boolean;
  print?: (line: string) => void;
}): Promise<string> {
  const print = opts.print ?? ((l: string): void => void process.stdout.write(`${l}\n`));
  const homeDir = opts.homeDir ?? OPENSQUID_HOME();
  const files = await buildExportList(homeDir);

  // Secret pass over every structured-config entry (fail-closed).
  const hits: string[] = [];
  const redacted = new Map<string, string>(); // rel → bundled content
  for (const rel of files) {
    if (!/\.(json|ya?ml)$/.test(rel)) continue;
    const raw = await readFile(join(homeDir, rel), 'utf8');
    let parsed: unknown;
    try {
      parsed = rel.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
    } catch {
      continue; // malformed config travels as-is; it cannot hide a parsed secret
    }
    if (rel === 'config.json' && parsed !== null && typeof parsed === 'object') {
      const safe = redactConfig(parsed as Record<string, unknown>);
      redacted.set(rel, `${JSON.stringify(safe, null, 2)}\n`);
      parsed = safe;
    }
    hits.push(...scanForSecrets(rel, parsed));
  }
  if (hits.length > 0) {
    throw new Error(
      `export refused — uncatalogued secret-shaped values (move them to env: refs or remove):\n  ${hits.join('\n  ')}`,
    );
  }

  const manifest: Manifest = {
    version: 1,
    opensquid: await localVersion(),
    created_at: new Date().toISOString(),
    files: files.length,
  };

  if (opts.dryRun === true) {
    print(`manifest: ${JSON.stringify(manifest)}`);
    for (const f of files) print(`  ${f}${redacted.has(f) ? '  [credentials redacted]' : ''}`);
    print('dry run — nothing written.');
    return '';
  }

  // Stage: copy the truth set (with redactions applied) into a tmp tree, add
  // the manifest, then tar.gz the tree. Staging keeps the live home strictly
  // read-only for the export.
  const stage = join(
    tmpdir(),
    `opensquid-export-${String(process.pid)}-${Date.now().toString(36)}`,
  );
  for (const rel of files) {
    const dst = join(stage, rel);
    await mkdir(join(dst, '..'), { recursive: true });
    if (redacted.has(rel)) {
      await writeFile(dst, redacted.get(rel) ?? '', 'utf8');
    } else {
      await writeFile(dst, await readFile(join(homeDir, rel)));
    }
  }
  await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const outPath =
    opts.out ?? join(process.cwd(), `opensquid-export-${manifest.created_at.slice(0, 10)}.tgz`);
  await tar.create({ gzip: true, file: outPath, cwd: stage }, ['.']);

  print(`exported ${String(files.length)} truth files → ${outPath}`);
  if (redacted.size > 0) {
    print('credentials REDACTED in the bundle (re-provide on import): chat_connections tokens');
  }
  print(
    'secrets scope: structured config is scanned/redacted; user-authored memory/lesson/inbox text is not — review where this bundle travels.',
  );
  return outPath;
}

// ---------------------------------------------------------------------------
// Import + rebuild.
// ---------------------------------------------------------------------------

const TRUTH_MARKERS = [
  'active.json',
  'channels.json',
  'config.json',
  'models.yaml',
  'packs',
  'phase_ledger',
  'projects',
  'projects.json',
  'store',
  'lessons',
  'memories',
  'umbrellas',
  'inbox',
];

export async function truthPresent(homeDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const m of TRUTH_MARKERS) {
    try {
      await stat(join(homeDir, m));
      found.push(m);
    } catch {
      /* absent */
    }
  }
  return found;
}

/** Each rebuild attempts independently; failure NEVER deletes extracted truth —
 *  the exact re-run command records and the caller exits non-zero. */
export async function rebuildProjections(
  homeDir: string,
  embedder = fastembedEmbedder(),
): Promise<{ rebuilt: string[]; failed: string[] }> {
  const rebuilt: string[] = [];
  const failed: string[] = [];
  const attempt = async (
    label: string,
    rerun: string,
    fn: () => Promise<string>,
  ): Promise<void> => {
    try {
      rebuilt.push(await fn());
    } catch (e) {
      failed.push(`${label}: ${e instanceof Error ? e.message : String(e)} — re-run: ${rerun}`);
    }
  };
  await attempt('memories', 'opensquid migrate-memories', async () => {
    const r = await migrateMemories({
      memDir: join(homeDir, 'memories'),
      sourceDir: join(homeDir, 'memories'),
      dbUrl: `file:${join(homeDir, 'rag.sqlite')}`,
      embedder,
    });
    return `memories (${String(r.migrated)})`;
  });
  await attempt('lessons', 'opensquid migrate-lessons', async () => {
    const r = await migrateWedgeLessons({
      dbUrl: `file:${join(homeDir, 'wg_lessons.db')}`,
      sourceDir: join(homeDir, 'lessons'),
    });
    return `lessons (${String(r.migrated)})`;
  });
  await attempt('workgraph', 'opensquid rebuild', async () => {
    // T-project-local-state PLS.5 — the workgraph is project-LOCAL now, so portability
    // rebuilds the LOCAL board (`<root>/.opensquid/workgraph.db` from `<root>/.opensquid/store/issues`),
    // NOT the global `homeDir` board. Start-fresh (design §6.1) deliberately ABANDONS the old global
    // `~/.opensquid/workgraph.db` — there is intentionally NO migration/import/replay of it; a fresh
    // local store's own `init()`/rebuild bootstraps an empty board (0 ops, no legacy-global leak).
    const localStore = await resolveLocalStoreDir(process.cwd());
    const n = await rebuildWorkGraph({
      dbUrl: `file:${join(localStore, 'workgraph.db')}`,
      sourceDir: join(localStore, 'store', 'issues'),
    });
    return `workgraph (${String(n)} ops)`;
  });
  return { rebuilt, failed };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

export async function runImport(opts: {
  bundle: string;
  homeDir?: string;
  list?: boolean;
  force?: boolean;
  embedder?: ReturnType<typeof fastembedEmbedder>;
  print?: (line: string) => void;
}): Promise<{ rebuilt: string[]; failed: string[] }> {
  const print = opts.print ?? ((l: string): void => void process.stdout.write(`${l}\n`));
  const homeDir = opts.homeDir ?? OPENSQUID_HOME();

  // Read the manifest + entry list without extracting.
  const entries: string[] = [];
  let manifestRaw = '';
  await tar.list({
    file: opts.bundle,
    onReadEntry: (entry) => {
      const rel = entry.path.replace(/^\.\//, '');
      if (rel && rel !== '.') entries.push(rel);
      if (rel === 'manifest.json') {
        entry.on('data', (c: Buffer) => (manifestRaw += c.toString('utf8')));
      }
    },
  });
  let manifest: Manifest | null = null;
  try {
    manifest = JSON.parse(manifestRaw) as Manifest;
  } catch {
    manifest = null;
  }

  if (opts.list === true) {
    print(`manifest: ${manifestRaw.trim() || '<missing>'}`);
    for (const e of entries.sort()) print(`  ${e}`);
    return { rebuilt: [], failed: [] };
  }

  // Refusal (a): lived-in home — NO override (no-silent-mutation; merge = v2).
  const present = await truthPresent(homeDir);
  if (present.length > 0) {
    throw new Error(
      `import refused — the target home already contains truth (${present.join(', ')}). ` +
        'Move it aside first; merge is not supported yet.',
    );
  }
  // Refusal (b): newer-version bundle — overridable by --force.
  if (manifest !== null && compareVersions(manifest.opensquid, await localVersion()) > 0) {
    if (opts.force !== true) {
      throw new Error(
        `import refused — the bundle is from a newer opensquid (${manifest.opensquid}). ` +
          'Upgrade first, or pass --force to proceed at your own risk.',
      );
    }
    print(`warning: importing a newer-version bundle (${manifest.opensquid}) under --force.`);
  }

  // Extract, skipping projection-shaped entries (warn instead of silence).
  await mkdir(homeDir, { recursive: true });
  await tar.extract({
    file: opts.bundle,
    cwd: homeDir,
    filter: (path) => {
      const rel = path.replace(/^\.\//, '');
      if (rel === 'manifest.json') return false;
      if (PROJECTION_SHAPED.test(rel)) {
        print(`warning: skipped projection-shaped bundle entry ${rel}`);
        return false;
      }
      return true;
    },
  });

  const result = await rebuildProjections(homeDir, opts.embedder ?? fastembedEmbedder());
  for (const r of result.rebuilt) print(`rebuilt: ${r}`);
  for (const f of result.failed) print(`REBUILD FAILED — ${f}`);
  print('redacted credentials (if any) must be re-provided: chat_connections tokens.');
  print('note: memory embeddings were rebuilt from text (the .vec cache is never bundled).');
  return result;
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

export function registerPortability(program: Command): void {
  program
    .command('export')
    .description(
      'Export the truth state of ~/.opensquid as a portable tar.gz (projections excluded; credentials redacted)',
    )
    .option('--out <path>', 'output bundle path')
    .option('--dry-run', 'print the manifest + file list without writing', false)
    .action(async (flags: { out?: string; dryRun?: boolean }) => {
      try {
        await runExport({
          ...(flags.out !== undefined ? { out: flags.out } : {}),
          ...(flags.dryRun === true ? { dryRun: true } : {}),
        });
      } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command('import <bundle>')
    .description(
      'Import an opensquid export bundle into a CLEAN home, then rebuild the projections',
    )
    .option('--list', 'show the bundle manifest + contents without writing', false)
    .option('--force', 'proceed when the bundle is from a newer opensquid version', false)
    .action(async (bundle: string, flags: { list?: boolean; force?: boolean }) => {
      try {
        const r = await runImport({
          bundle,
          ...(flags.list === true ? { list: true } : {}),
          ...(flags.force === true ? { force: true } : {}),
        });
        if (r.failed.length > 0) process.exitCode = 1;
      } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command('rebuild')
    .description('Rebuild the sqlite projections (memories/lessons/workgraph) from the file truth')
    .action(async () => {
      const r = await rebuildProjections(OPENSQUID_HOME());
      for (const line of r.rebuilt) process.stdout.write(`rebuilt: ${line}\n`);
      for (const f of r.failed) process.stderr.write(`REBUILD FAILED — ${f}\n`);
      if (r.failed.length > 0) process.exitCode = 1;
    });
}
