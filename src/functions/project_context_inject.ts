/**
 * T-project-context — `project_context_inject` primitive.
 *
 * Emits a project's free-form `context.md` prose as an `inject_context` envelope.
 * The content is BAKED into the rule's `args.content` at load time (loader:
 * `project_context.ts` reads the file once and compiles it into the rule),
 * exactly as `compileGuards` bakes `verdict.message` — so this primitive is a
 * pure echo, no runtime file I/O. The surfacing event set (session_start +
 * prompt_submit) is enforced by the synthetic skill's `triggers`, not here.
 */
import { z } from 'zod';

import { ok } from '../runtime/result.js';

import { buildInjectContext } from './inject_context.js';
import type { FunctionRegistry } from './registry.js';

const Args = z.object({ content: z.string() }).strict();

export function registerProjectContextInject(registry: FunctionRegistry): void {
  registry.register({
    name: 'project_context_inject',
    argSchema: Args,
    durable: false,
    memoizable: false,
    costEstimateMs: 1,
    execute: (args) => {
      const content = args.content.trim();
      // empty body → nothing to inject
      return Promise.resolve(content.length === 0 ? ok(null) : ok(buildInjectContext(content)));
    },
  });
}
