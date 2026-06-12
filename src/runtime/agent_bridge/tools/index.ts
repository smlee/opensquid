/**
 * agent_bridge built-in tools — barrel + BUILT_INS registry.
 *
 * Authoritative spec: the warm-agent planning notes (not retained — docs/tasks/WAB.1-architecture.md is the surviving authority) WAB.6 §"Tool
 * surface". The three built-ins (`chat_send`, `recall`, `store_lesson`) are
 * shipped as factories — `pack_binding.ts` constructs them with the
 * runtime-wide dependencies (RagBackend, optional daemon-send seam) and
 * assembles the final `SimpleToolDispatcher`.
 *
 * Why factories (not pre-built `ToolRegistration` objects):
 *   - `chat_send` needs a daemon-send seam (closes over the UDS socket).
 *   - `recall` needs the `RagBackend` instance.
 *   - `store_lesson` needs an optional clock seam for tests.
 *   Hard-coding these into a singleton list would force every consumer to
 *   take the production wiring even in unit tests.
 *
 * `BUILT_INS` is the sealed list of names. Used by `pack_binding.ts` to
 * iterate the built-in tool set and apply `disable_builtins` filtering.
 * Matches `BuiltinToolName` from `src/packs/schemas/chat_agent.ts` — the
 * two are kept in lockstep; adding a future built-in requires updating
 * BOTH (and the schema enum + tests).
 *
 * Imports from: ./chat_send.js, ./recall.js, ./store_lesson.js.
 * Imported by: ../pack_binding.ts.
 */

import type { BuiltinToolName } from '../../../packs/schemas/chat_agent.js';

export {
  chatSendSpec,
  defaultDaemonSend,
  makeChatSendHandler,
  type DaemonSendFn,
  type DaemonSendParams,
} from './chat_send.js';
export { recallSpec, makeRecallHandler } from './recall.js';
export {
  bufferPath as storeLessonBufferPath,
  makeStoreLessonHandler,
  storeLessonSpec,
  type MakeStoreLessonHandlerOptions,
} from './store_lesson.js';

/**
 * Sealed list of built-in tool names. Order matches the spec's enumeration
 * (chat_send, recall, store_lesson) and is the same insertion order the
 * dispatcher will reflect via `list()`. Type-checked against
 * `BuiltinToolName` so a drift between the schema enum and this array
 * surfaces at compile time.
 */
export const BUILT_INS: readonly BuiltinToolName[] = ['chat_send', 'recall', 'store_lesson'];
