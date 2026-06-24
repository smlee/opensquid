/**
 * Always-on raw-turn capture into RAG — the live wiring of T-memory-foundation (design §5). Mirrors the
 * `stop_drive.ts` / `stop_stream.ts` `maybe*` pattern: a function `stop.ts` calls on every Stop. Extracts
 * the transcript path from the Stop payload, builds the shared backend, and ingests the full transcript.
 *
 * Fail-open: a capture failure NEVER throws into the hook (the turn is never blocked by ingest). The
 * `makeBackend` / `ingest` seams make the live path injectable, so the test here IS the live-path proof.
 */
import type { RagBackend } from '../../rag/types.js';
import { createBackend } from '../../rag/backend_factory.js';
import { resolveBackendConfig } from '../../rag/config.js';
import { ingestTurn } from '../../rag/memory/ingest.js';

interface StopIngestPayload {
  transcript_path?: string;
  transcriptPath?: string;
  cwd?: string;
}

export interface IngestHookDeps {
  /** Seam for tests — defaults to the configured backend (`createBackend(await resolveBackendConfig())`). */
  makeBackend?: () => RagBackend;
  /** Seam for tests — defaults to the real `ingestTurn`. */
  ingest?: typeof ingestTurn;
}

/**
 * Capture the just-completed turn into RAG. Returns the number of rows written (0 when the payload carries
 * no transcript path, or on any failure). Always-on: the caller invokes it unconditionally on Stop.
 */
export async function maybeIngestTurn(raw: string, deps: IngestHookDeps = {}): Promise<number> {
  let transcriptPath: string | null = null;
  let cwd: string | undefined;
  try {
    const obj = JSON.parse(raw) as StopIngestPayload;
    transcriptPath = obj.transcript_path ?? obj.transcriptPath ?? null;
    cwd = obj.cwd; // authoritative for project scope; ingest falls back to process.cwd() if absent
  } catch {
    return 0;
  }
  if (transcriptPath === null) return 0;
  try {
    const backend = deps.makeBackend
      ? deps.makeBackend()
      : createBackend(await resolveBackendConfig());
    await backend.init();
    return await (deps.ingest ?? ingestTurn)({
      backend,
      transcriptPath,
      ...(cwd === undefined ? {} : { cwd }),
    });
  } catch (err) {
    process.stderr.write(`opensquid: turn-ingest failed (continuing): ${String(err)}\n`);
    return 0;
  }
}
