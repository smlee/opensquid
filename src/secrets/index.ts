/**
 * Secrets: pluggable secrets resolver dispatching by URI scheme (env:, .env,
 * op://, keychain:) with in-memory-only runtime cache.
 *
 * Imports from: nothing in src/ (sibling layer).
 * Imported by: runtime/, channels/, models/, rag/, setup/, mcp/.
 */

export type { SecretBackend, SecretResolver } from './types.js';
export { createResolver } from './resolver.js';
export { dotenvBackend, type DotenvBackendOptions } from './backends/dotenv.js';
