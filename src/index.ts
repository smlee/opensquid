/**
 * opensquid public entry — re-exports the runtime API as the package surface.
 *
 * T.2 (loop-engine re-integration): expose `./engine/*` so external
 * consumers can spawn the engine, build typed JSON-RPC calls, and
 * branch on the five custom `ENGINE_ERROR` codes without reaching into
 * subpath imports.
 */
export * from './engine/index.js';
