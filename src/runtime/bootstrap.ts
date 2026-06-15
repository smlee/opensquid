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
 *     resolves pack sources, parses pack YAML, and respects per-skill load
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

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { wedgeLessonStore, type WedgeLessonStore } from '../rag/wedge/store.js';
import { wedgeLessonsDbUrl, wedgeLessonsDir } from '../rag/wedge/paths.js';
import { registerDestinationCheckFunction } from '../functions/destination_check.js';
import { registerCachedAuditFunction } from '../functions/cached_audit.js';
import { registerEventFunctions } from '../functions/event.js';
import { IsAutomationMode } from '../functions/is_automation_mode.js';
import { registerLessonFunctions } from '../functions/lessons.js';
import { registerLlmFunctions } from '../functions/llm.js';
import {
  HasActiveTask,
  HasGeneratedSpec,
  OpenTaskCount,
  TaskListGenerated,
  WorkflowPhasesComplete,
} from '../functions/active_task.js';
import { CheckFlowHealth } from '../functions/check_flow_health.js';
import { HandoffSessionStart } from '../functions/handoff_session_start.js';
import { SessionStatusManifest } from '../functions/session_status_manifest.js';
import { EffectiveContent } from '../functions/effective_content.js';
import { ChatWatcherAutostart } from '../functions/chat_watcher_autostart.js';
import { ScopeDwellTick } from '../functions/scope_dwell.js';
import { PathExists } from '../functions/path_exists.js';
import { registerRagFunctions } from '../functions/rag.js';
import { registerRecallPreInjectFunction } from '../functions/recall_pre_inject.js';
import { FunctionRegistry } from '../functions/registry.js';
import { SessionToolHistory } from '../functions/session_tool_history.js';
import { registerStateFunctions } from '../functions/state.js';
import { registerStagedDocsOnlyFunction } from '../functions/staged_docs_only.js';
import { registerResetScopeTrackStateFunction } from '../functions/reset_scope_track_state.js';
import { registerArmScopeFunction } from '../functions/arm_scope.js';
import { registerFsmFunctions } from '../functions/fsm.js';
import { registerReadRubric } from '../functions/read_rubric.js';
import { registerRubricPreInject } from '../functions/rubric_pre_inject.js';
import { registerProcedurePreInject } from '../functions/procedure_pre_inject.js';
import { registerSetRequestType } from '../functions/set_request_type.js';
import { registerSubagentFunction } from '../functions/subagent.js';
import { registerCheckChatConnectionFunction } from '../functions/check_chat_connection.js';
import { registerEnsureUmbrellaTopicFunction } from '../functions/ensure_umbrella_topic.js';
import { TextPatternMatch } from '../functions/text_pattern_match.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import { discoverActivePacks } from '../packs/discovery.js';
import { type DetectionContext } from './detection.js';
import { sortPacksByScope } from '../packs/load_order.js';
import { loadPack } from '../packs/loader.js';
import { createBackend } from '../rag/backend_factory.js';
import { resolveBackendConfig } from '../rag/config.js';

import { resolveBuiltinScopeRoot, resolveProjectScopeRoot, resolveUserScopeRoot } from './paths.js';

import type { RagBackend } from '../rag/types.js';
import type { Pack } from './types.js';

export interface BuildRegistryOpts {
  /** Inject a pre-built backend (tests). Skips config resolution + init. */
  backend?: RagBackend;
  /**
   * Inject a pre-built wedge lesson store for the lesson primitives (tests).
   * Production builds construct a fresh `wedgeLessonStore` over libSQL + the
   * status-dir per-file source (retire-Rust RES-3c — the lesson surface no
   * longer touches the Rust engine).
   *
   * Pass an explicit stub (or `null`) in tests that exercise pure runtime
   * paths and don't want a real store. `null` disables lesson registration
   * entirely; `undefined` constructs a fresh store (production default).
   */
  lessonStore?: WedgeLessonStore | null;
}

export async function buildRegistry(opts: BuildRegistryOpts = {}): Promise<FunctionRegistry> {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerStateFunctions(r);
  registerStagedDocsOnlyFunction(r);
  registerResetScopeTrackStateFunction(r);
  registerArmScopeFunction(r);
  registerFsmFunctions(r);
  registerVerdictFunctions(r);
  registerLlmFunctions(r);
  registerCachedAuditFunction(r);
  registerReadRubric(r); // TR.A: the audits interpolate {{rubric}} from this; rubric_pre_inject reuses it
  registerRubricPreInject(r); // TR.B: injects the rubric to the agent before authoring (prompt_submit)
  registerProcedurePreInject(r); // wg-7f6225238a27: injects the pack's operating procedure when engaged (prompt_submit)
  registerSetRequestType(r); // wg-3d175ec06767: RTC.5 llm refinement writes the refined request-type
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
  // T-HANDOFF-HARDENING HH6.2 — `check_chat_connection` is a read-only,
  // fail-quiet primitive that the `session-connection-check` skill calls on
  // `session_start` to surface the project's chat-connection state (+ generic
  // umbrella-routing-drift) as an inject_context. No backend dep → sync
  // registration here.
  registerCheckChatConnectionFunction(r);
  // T-CHAT-AS-TERMINAL CAT.7 — `ensure_umbrella_topic` is the SessionStart
  // topic-assurance ACTION (sanctioned by the remote-terminal override). On
  // `session_start`, IF a chat daemon is live and the session's umbrella owns a
  // telegram chat_id but ZERO topic, it creates exactly one topic via the
  // daemon `create_topic` RPC and writes topic_id back into channels.json. Once
  // set, it's a no-op — the umbrella↔topic ≤1:1 invariant holds by
  // construction. Fail-quiet (never blocks session start). Default seams dial
  // the real daemon socket; tests inject stubs via a separate registry.
  registerEnsureUmbrellaTopicFunction(r);
  // G.5 — text-pattern matcher + per-turn tool-call ledger reader. Both are
  // pure (no I/O for text_pattern_match; one read for session_tool_history)
  // so they ship pre-registered as FunctionDef objects rather than via a
  // dedicated registrar helper. The drift skill `verify-before-citing-memory`
  // composes them in a process: text scan → tool-history lookup → verdict.
  r.register(TextPatternMatch);
  r.register(SessionToolHistory);
  // Track SD.1 — `path_exists` is a pure read-only directory scan (one
  // readdir, no content reads, cwd-subtree-confined). It backs the
  // `scope-decomposer` hard gate's "no pre-research artifact on disk" check.
  // memoizable:false so the gate sees an artifact the moment the agent
  // creates it mid-session.
  r.register(PathExists);
  // G.12 — `is_automation_mode` returns whether the current session is in
  // an automation loop (env var OR `~/.opensquid/sessions/<id>/automation.flag`).
  // Skills like `d9-guard` gate `if: 'automation.value === true'` so their
  // Stop-event llm_classify only fires inside `/loop`-style automation,
  // preventing the politeness-reflex prompt from interrupting normal
  // interactive use.
  r.register(IsAutomationMode);
  // AP.4 — workflow-gate read-side: `has_active_task` (is a task active +
  // its provenance track id) and `workflow_phases_complete` (all 7 REQUIRED
  // phases logged for the LIVE active task). Both read-only, memoizable:false
  // (active task + phase ledger change mid-session). Back the personal-pack
  // workflow gate (rule #8) + the scope→task Gate A (AP.5).
  r.register(HasActiveTask);
  r.register(WorkflowPhasesComplete);
  // AP.5 — scope→task Gate A read-side: does the active task have generator
  // provenance (a docs/tasks spec that resolves on disk)? H7: spec is absolute
  // (cross-repo: spec in the planning repo, code-write in another).
  r.register(HasGeneratedSpec);
  // AP.5 — scope→task Gate B read-side: does the WHOLE open task list have
  // provenance (every pending/in_progress task carries metadata.taskId)? Closes
  // Gate A's smuggled-task loophole.
  r.register(TaskListGenerated);
  // AF.6 — open-task count; the pause-gates derive run-active (auto-off when the
  // backlog is depleted) from this + the FSM state.
  r.register(OpenTaskCount);
  // T-FLOW-UNSKIPPABLE FU.3 (D3) — SessionStart health assurance: a loud
  // inject_context when the opensquid hooks aren't wired or no gate pack is active
  // (the F3 silent-un-gated case). Dispatched on session_start by coding-flow's
  // flow-health-check skill.
  r.register(CheckFlowHealth);
  // T-SESSION-STATUS-MANIFEST — ONE consolidated "what opensquid is connected to"
  // report on every session begin (chat + flow + packs + daemon + engine).
  // Dispatched on session_start by default-discipline's session-connection-check
  // skill; supersedes the fragmented chat/flow injects (DRY: reuses
  // flowEnforcementProblems).
  r.register(SessionStatusManifest);
  r.register(HandoffSessionStart);
  // T-FLOW-AUDIT-ARTIFACT — effective post-write content so the SCOPE/AUTHOR
  // content audits evaluate the real resulting file (Edit-safe), not the
  // Edit-empty `tool_args.content` that broke iterative refinement.
  r.register(EffectiveContent);
  // T-CHAT-REALTIME — make SessionStart actually set up chat: a session_start
  // inject_context directing the agent to start the inbound watcher (Monitor +
  // `chat watch`) so messages arrive in real time (no turn-boundary wait, no flag).
  r.register(ChatWatcherAutostart);
  // T-FLOW-UNSKIPPABLE FU.2 (D2) — scope-sprawl escalation: ticks a per-session
  // dwell counter while the FSM is in scoping/researching; the entry-and-handoffs
  // prompt_submit rule surfaces a "converge the scope" directive at the threshold.
  r.register(ScopeDwellTick);
  // T-ASC ASC.5 — chain-state read primitive. Exposes the persisted T-ASC
  // chain (stage + enrichment fields) to skill YAML `process:` chains so
  // ASC.5's reframed scope-decomposer handoff rules can shape their
  // directive next_action.args from the persisted stage. memoizable:false
  // because the chain transitions mid-session via the ASC.1 writers.
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
  // direct EngineClient handle (the RAG backend handles memory.* calls; the
  // lesson.* wedge gate still routes through the engine — RES-3 will port it).
  // Construct + init the wedge lesson store (libSQL + per-file source), then
  // register the lesson primitives against it. Tests pass `lessonStore: null`
  // to skip registration; `lessonStore: <stub>` to inject a store.
  if (opts.lessonStore !== null) {
    const store =
      opts.lessonStore ??
      wedgeLessonStore({ dbUrl: wedgeLessonsDbUrl(), sourceDir: wedgeLessonsDir() });
    await store.init();
    registerLessonFunctions(r, store);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Validation registry (T-wire-pack-validators PV.1).
//
// A FunctionRegistry with EVERY primitive NAME registered but NO real backend
// (no libsql/embedder I/O). For pack validation, which only reads
// `registry.has`/`list`. The no-op backends satisfy the interfaces so all
// names register; init() resolves and the other methods are never invoked
// during validation. The lessonStore is a STUB (NOT null) so the lesson
// primitive names (propose/promote/recall_lesson) register — `null` would
// DROP them and false-fail any pack that calls them.
// ---------------------------------------------------------------------------

const NOOP_BACKEND: RagBackend = {
  init: () => Promise.resolve(),
  embed: () => Promise.resolve(null),
  recall: () => Promise.resolve([]),
  storeLesson: () => Promise.resolve(),
  deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
};

const NOOP_LESSON_STORE: WedgeLessonStore = {
  init: () => Promise.resolve(),
  createLesson: () => Promise.reject(new Error('validation registry: lesson store is unused')),
  promoteLesson: () => Promise.reject(new Error('validation registry: lesson store is unused')),
  recallLesson: () => Promise.resolve({ query: '', returned: 0, results: [] }),
  captureFeedback: () => Promise.resolve(),
  recordApplied: () => Promise.resolve(),
  rebuild: () => Promise.resolve({ indexed: 0 }),
};

/** Build a names-complete registry with no-op backends (no I/O) — for pack validation only. */
export async function buildValidationRegistry(): Promise<FunctionRegistry> {
  return buildRegistry({ backend: NOOP_BACKEND, lessonStore: NOOP_LESSON_STORE });
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
    const cwd = process.cwd();
    // IDF.3 — pre-stage a DetectionContext from cwd so opted-in packs
    // with `detected_by[]` clauses gate their load on the current
    // project signals. Opt-in is still required (packs not in
    // active.json never load); detected_by gates WHEN among opt-in.
    const ctx = await buildDetectionContext(cwd);
    // BPDISC — resolve the built-in pack root so discoverActivePacks can
    // fall back to `<npm-install>/packs/builtin/<name>/` when an active.json
    // entry isn't installed at user / project scope. Without this fallback,
    // listing a built-in pack name in active.json (default-discipline,
    // scope-architect, focused-react-19, ...) ENOENT-crashes the hook.
    const builtinRoot = resolveBuiltinScopeRoot();
    const user = await discoverActivePacks(resolveUserScopeRoot(), ctx, builtinRoot);
    const projectRoot = await resolveProjectScopeRoot(cwd);
    const project = await discoverActivePacks(projectRoot, ctx, builtinRoot);
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

/**
 * IDF.3 — pre-stage a `DetectionContext` from the current cwd. Reads
 * existence flags for well-known files + parses package.json/tsconfig.json/
 * Cargo.toml contents so `detected_by` `file_match`/`file_exists` clauses
 * can evaluate without I/O at the dispatch layer.
 *
 * Perf budget (per IDF.3 spec risk callout): the real loader runs ONCE
 * per hook subprocess (module-load `realPacksPromise`), so this fn pays
 * its disk cost exactly once. No recursive walk in this version — IDF.3
 * ships the eager well-known-file path; deeper traversal + memory recall
 * are deferred follow-ups. memoryBodies + recentPrompts + userPinned
 * stay empty/false — populated by Phase 2/3 work.
 */
async function buildDetectionContext(cwd: string): Promise<DetectionContext> {
  const files: Record<string, boolean> = {};
  const fileContents: Record<string, string> = {};

  const wellKnown = [
    'package.json',
    'tsconfig.json',
    'Cargo.toml',
    'pyproject.toml',
    'go.mod',
  ] as const;
  for (const name of wellKnown) {
    try {
      const body = await fsp.readFile(join(cwd, name), 'utf8');
      fileContents[name] = body;
      files[name] = true;
    } catch {
      // missing file — leave maps absent
    }
  }

  return {
    cwd,
    files,
    dirs: {},
    fileContents,
    memoryBodies: '',
    recentPrompts: '',
    userPinned: false,
  };
}

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
