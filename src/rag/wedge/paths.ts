/**
 * Filesystem paths for the wedge lesson store (retire-Rust RES-3c). Resolves the dedicated
 * `wg_lessons` DB + the status-dir per-file source root under OPENSQUID_HOME (so tests can redirect
 * via the env var). Separate from the memory store paths.
 *
 * Imports from: node:path, ../../runtime/paths.js.
 * Imported by: src/runtime/bootstrap.ts, src/mcp/server.ts.
 */
import { join } from 'node:path';

import { OPENSQUID_HOME } from '../../runtime/paths.js';

export const wedgeLessonsDbUrl = (): string => `file:${join(OPENSQUID_HOME(), 'wg_lessons.db')}`;
export const wedgeLessonsDir = (): string => join(OPENSQUID_HOME(), 'lessons');
