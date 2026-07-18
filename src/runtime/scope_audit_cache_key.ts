import { isDesignDoc } from './guard/orchestrator_guard.js';

/**
 * Derive a per-artifact branch from a pack-declared base cache key. Core assigns no pack or stage meaning to
 * the key; writer and reader must pass the same declaration.
 */
export function scopeAuditCacheKey(filePath: string, baseKey: string): string {
  if (!isDesignDoc(filePath)) return baseKey;
  const marker = 'docs/design/';
  const index = filePath.lastIndexOf(marker);
  const relative = index >= 0 ? filePath.slice(index) : filePath;
  const safe = relative.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${baseKey}-doc-${safe}`;
}
