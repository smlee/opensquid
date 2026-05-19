/**
 * Function library: atomic primitives that skills compose into rule processes.
 *
 * The registry is the only path from a skill step to a primitive — packs
 * resolve `function:` refs via `FunctionRegistry.call()`. Primitives live
 * in sibling modules and are registered into a per-runtime instance.
 *
 * Imports from: runtime/types.ts, runtime/result.ts (transitively via registry).
 * Imported by: runtime/, packs/.
 */
export * from './registry.js';
