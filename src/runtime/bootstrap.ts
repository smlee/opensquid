/**
 * Runtime bootstrap — function registry + active-pack source for hook binaries.
 *
 * Two entry points every hook binary imports:
 *
 *   - `buildRegistry()` — assembles a `FunctionRegistry` with all primitive
 *     families registered: event / state / verdict / llm. RAG is NOT
 *     registered here (see "RAG omission" below).
 *
 *   - `loadActivePacks(sessionId)` — Phase 1 test seam. Returns whatever was
 *     last `setActivePacks(...)`'d in-process, or — for subprocess-launched
 *     hooks — packs serialized via the `OPENSQUID_TEST_PACK` env var. Phase 2
 *     replaces this with a real YAML loader that reads `~/.opensquid/active.json`,
 *     resolves codex sources, parses pack YAML, and respects per-skill load
 *     modes. The `Promise<Pack[]>` signature is pinned now so the Phase 2
 *     swap is body-only — call sites do not refactor.
 *
 * RAG wiring (T-loop-engine-reintegration / T.3 — first-ever production
 * registration of recall/embed/store_lesson):
 *   `registerRagFunctions(registry, backend)` is now called per-bootstrap
 *   with a backend chosen by `resolveBackendConfig()` (env > config.json >
 *   default = loop-engine if engine binary discoverable, else libsql-qwen3).
 *   The cost concerns that justified Phase 1 omission are resolved: the
 *   default `loop-engine` path connects to a shared UDS daemon (T.4), so
 *   per-hook boot cost is one socket-connect + one ping, not a full libsql
 *   open. `buildRegistry()` becomes async to accommodate `backend.init()`
 *   (engine handshake / libsql CREATE TABLE depending on backend). All
 *   four hook bins already await it.
 *
 * Two env-var test seams (subprocess hook bridge):
 *
 *   `OPENSQUID_TEST_PACK` (Phase-1 legacy seam, kept for backward compat):
 *     A JSON-encoded `Pack` object the child self-seeds at module-load.
 *     Phase 2.7 keeps this so existing call sites and any in-flight tests
 *     that hand-build a pack still work. Malformed JSON is silently ignored
 *     (returns `[]`) — fail-safe, test-only. NEVER document in user docs.
 *
 *   `OPENSQUID_TEST_PACK_DIR` (Phase-2.7 seam, preferred):
 *     An absolute path to an on-disk YAML pack folder (`manifest.yaml` +
 *     `skills/*\/skill.yaml`). The child invokes the real `loadPack` from
 *     `src/packs/loader.ts` synchronously at module load via a promise +
 *     `await` chain handed to `loadActivePacks`. Errors are swallowed at
 *     the same fail-safe contract as the JSON seam — a missing folder or
 *     malformed YAML yields `[]`, surfacing as the empty-active-packs
 *     "allow everything" path. That keeps the seam a strict superset of
 *     Phase-1 behavior so tests can flip from inline → on-disk without
 *     changing assertions.
 *
 *   Both seams compose: if `OPENSQUID_TEST_PACK_DIR` is set, its loaded
 *   pack is appended to whatever `OPENSQUID_TEST_PACK` produced. In
 *   practice tests use exactly one of the two.
 *
 * Imports from: functions/, packs/loader.
 * Imported by: runtime/hooks/*.ts (per-hook binaries), runtime/index.ts (re-export).
 */

import { EngineClient } from '../engine/client.js';
import { registerDestinationCheckFunction } from '../functions/destination_check.js';
import { registerEventFunctions } from '../functions/event.js';
import { registerLessonFunctions } from '../functions/lessons.js';
import { registerLlmFunctions } from '../functions/llm.js';
import { registerRagFunctions } from '../functions/rag.js';
import { registerRecallPreInjectFunction } from '../functions/recall_pre_inject.js';
import { FunctionRegistry } from '../functions/registry.js';
import { SessionToolHistory } from '../functions/session_tool_history.js';
import { registerStateFunctions } from '../functions/state.js';
import { registerSubagentFunction } from '../functions/subagent.js';
import { TextPatternMatch } from '../functions/text_pattern_match.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import { discoverActivePacks } from '../packs/discovery.js';
import { sortPacksByScope } from '../packs/load_order.js';
import { loadPack } from '../packs/loader.js';
import { createBackend } from '../rag/backend_factory.js';
import { resolveBackendConfig } from '../rag/config.js';

import { resolveProjectScopeRoot, resolveUserScopeRoot } from './paths.js';

import type { RagBackend } from '../rag/types.js';
import type { Pack } from './types.js';

export interface BuildRegistryOpts {
  /** Inject a pre-built backend (tests). Skips config resolution + init. */
  backend?: RagBackend;
  /**
   * Inject a pre-built EngineClient for the lesson primitives (T.6 tests).
   * Production builds construct a fresh `EngineClient` that lazily connects
   * to the shared UDS daemon via the T.4 singleton — multiple clients across
   * RAG + lessons safely share the same daemon process.
   *
   * Pass an explicit stub (or `null`) in tests that exercise pure runtime
   * paths and don't want to spawn / connect to a real engine. `null`
   * disables lesson registration entirely; `undefined` constructs a fresh
   * client (production default).
   */
  engineClient?: EngineClient | null;
}

export async function buildRegistry(opts: BuildRegistryOpts = {}): Promise<FunctionRegistry> {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerStateFunctions(r);
  registerVerdictFunctions(r);
  registerLlmFunctions(r);
  // Phase 4: `check_destination` is the destination-side anti-drift
  // primitive. It composes `llm_classify` (registered just above) so the
  // ordering matters — register it last among the LLM-dependent primitives.
  // Future destination_check rules and the Phase-4.3 scheduler call into
  // this primitive name.
  registerDestinationCheckFunction(r);
  // Phase 6: `spawn_subagent` is the Mode-A orchestration primitive. SDK is
  // loaded lazily inside the primitive (optional peer dep), so registering
  // here adds zero startup cost when no pack actually invokes it. Tests can
  // override the SDK via `registerSubagentFunction(r, { sdk: stub })` against
  // a separate registry; the production bootstrap always uses the lazy
  // dynamic-import path.
  registerSubagentFunction(r);
  // G.5 — text-pattern matcher + per-turn tool-call ledger reader. Both are
  // pure (no I/O for text_pattern_match; one read for session_tool_history)
  // so they ship pre-registered as FunctionDef objects rather than via a
  // dedicated registrar helper. The drift skill `verify-before-citing-memory`
  // composes them in a process: text scan → tool-history lookup → verdict.
  r.register(TextPatternMatch);
  r.register(SessionToolHistory);
  // T-loop-engine-reintegration T.3 — FIRST-EVER production wiring of the
  // RAG primitives. Resolves backend choice (env > ~/.opensquid/rag-config
  // .json > default), constructs, inits, registers. Tests override via
  // `opts.backend` to skip the resolver + a real init (which may need a
  // live engine binary).
  const backend = opts.backend ?? createBackend(await resolveBackendConfig());
  await backend.init();
  registerRagFunctions(r, backend);
  // G.4 — `recall_pre_inject` shares the same backend handle as `recall`
  // (no second connection). Registered immediately after RAG so the backend
  // is guaranteed initialized; the primitive itself ignores non-prompt_submit
  // events at the per-call boundary as a defensive guard on top of the
  // dispatcher's skill-trigger filter.
  registerRecallPreInjectFunction(r, backend);

  // T-loop-engine-reintegration T.6 — wire the wedge gate lesson surface
  // (`propose_lesson`, `promote_lesson`, `recall_lesson`). Lessons need a
  // direct EngineClient handle (the RAG backend wraps memory.* calls, not
  // lesson.* calls — see src/rag/backends/loop_engine.ts header §1).
  // Lazy connect: the client doesn't touch the socket until the first
  // primitive call, so registering here adds zero startup cost when no
  // pack actually invokes a lesson primitive. Tests pass `engineClient: null`
  // to skip registration; `engineClient: <stub>` to inject a stub.
  if (opts.engineClient !== null) {
    const client = opts.engineClient ?? new EngineClient();
    registerLessonFunctions(r, client);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Active packs — three composing sources (G.1 lands the third one).
//
//   1. Test seam: `OPENSQUID_TEST_PACK`     (inline JSON pack object)
//   2. Test seam: `OPENSQUID_TEST_PACK_DIR` (path to a pack folder)
//   3. Real loader: user-scope + project-scope `active.json` (G.1)
//
// The two test seams keep their fail-OPEN contract verbatim — fixtures are
// opensquid-authored, so a malformed fixture stays a test bug and shouldn't
// crash the hook binary mid-tool-call. The real loader path (3) fails LOUD
// per `project_opensquid_runtime_failure_handling` — user-authored config
// bugs must surface, not silent-fail to the "allow everything" path.
//
// Composition order in `loadActivePacks`:
//   in-process override (`setActivePacks`) → env seam → disk seam → real on-disk
//
// `setActivePacks` is the test override that completely replaces the
// in-process list; env+disk+real compose by concatenation. The real-loader
// output is run through `sortPacksByScope` to land 5-tier scope ordering
// across user-scope + project-scope packs; the test seams are NOT sorted
// because tests want to assert exact insertion order.
// ---------------------------------------------------------------------------

function loadFromEnv(): Pack[] {
  const raw = process.env.OPENSQUID_TEST_PACK;
  if (raw === undefined || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    // Trust shape at this seam — the test pack is opensquid-authored, and
    // mis-shaped input surfaces immediately as the evaluator rejects rules
    // it can't parse. A full Zod parse here would force a circular import
    // (types.ts -> bootstrap.ts -> types.ts) for zero benefit.
    return [parsed as Pack];
  } catch {
    return [];
  }
}

// Sync constant — the JSON env-var path is read at module load (no I/O).
const envPacks: Pack[] = loadFromEnv();

// Async test seam — the on-disk YAML path requires fs reads. Resolved at
// module load too; `loadActivePacks` awaits the same promise on every call
// so the load happens exactly once per hook subprocess. Errors are swallowed
// per the seam contract (see header) — a broken fixture yields the empty
// "allow everything" path rather than crashing the hook binary mid-tool-call.
const diskPacksPromise: Promise<Pack[]> = (async () => {
  const dir = process.env.OPENSQUID_TEST_PACK_DIR;
  if (dir === undefined || dir === '') return [];
  try {
    return [await loadPack(dir)];
  } catch {
    return [];
  }
})();

// G.1 — real on-disk loader. Composes both installation scopes:
//   - user scope: `~/.opensquid/` (via `resolveUserScopeRoot()`)
//   - project scope: walked up from `process.cwd()` (via
//     `resolveProjectScopeRoot(...)`); `null` when no `.opensquid/` exists
//     in or above cwd, in which case `discoverActivePacks` returns `[]`.
//
// Fail-LOUD: any thrown error from `discoverActivePacks` (malformed
// active.json, missing pack folder, broken manifest.yaml) is rethrown
// after a stderr blame line so the user can see WHICH file is wrong. This
// is the diametric opposite of the two test seams above, which fail-OPEN.
//
// One-shot resolution at module load: hooks run as short-lived subprocesses,
// so we pay the disk-read cost once per hook invocation, not once per call.
const realPacksPromise: Promise<Pack[]> = (async () => {
  try {
    const user = await discoverActivePacks(resolveUserScopeRoot());
    const projectRoot = await resolveProjectScopeRoot(process.cwd());
    const project = await discoverActivePacks(projectRoot);
    return sortPacksByScope([...user, ...project]);
  } catch (e) {
    // Surface the path-bearing error to stderr so the user can act on it,
    // then rethrow. The hook binary's top-level `main().catch(...)` is
    // fail-OPEN (exit 0 with stderr) so this never blocks the parent
    // agent — but the user sees the message and can fix the config.
    process.stderr.write(`[opensquid] active pack load failed: ${(e as Error).message}\n`);
    throw e;
  }
})();

let activePacks: Pack[] = envPacks;

export function setActivePacks(packs: Pack[]): void {
  activePacks = packs;
}

/**
 * Returns the composed active-pack list for this hook subprocess.
 *
 * Order: in-process override (`setActivePacks`) wins outright; on top of
 * that the env-var JSON seam, the disk-YAML seam, and the real on-disk
 * loader compose by concatenation. Real-loader output is scope-sorted
 * before concat; test-seam packs preserve insertion order so tests can
 * assert specific positioning.
 */
export async function loadActivePacks(_sessionId: string): Promise<Pack[]> {
  const [disk, real] = await Promise.all([diskPacksPromise, realPacksPromise]);
  return [...activePacks, ...disk, ...real];
}
