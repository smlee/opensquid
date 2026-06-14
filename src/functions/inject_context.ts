/**
 * Shared `inject_context` payload builder (wg-7f6225238a27).
 *
 * Single-sources the `{ kind: 'inject_context', content }` envelope that the dispatcher
 * aggregates and emits as Claude Code's `hookSpecificOutput.additionalContext` at
 * UserPromptSubmit (`src/runtime/hooks/dispatch.ts`). Both `rubric_pre_inject` (TR.B) and
 * `procedure_pre_inject` (the per-pack operating-procedure injector) return this exact shape,
 * so they cannot drift in the envelope/`kind` literal. The CONTENT composition differs per
 * primitive (the rubric is a multi-section quality bar; the procedure is a header + the pack's
 * own manual) — only the envelope is shared, which is the genuinely-common part.
 */

export interface InjectContextResult {
  kind: 'inject_context';
  content: string;
}

/** Wrap an already-composed content string in the inject_context envelope. */
export function buildInjectContext(content: string): InjectContextResult {
  return { kind: 'inject_context', content };
}
