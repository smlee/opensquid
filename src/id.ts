/**
 * Lesson ID generator. Matches `loop-engine`'s `les-<hex>` shape so
 * IDs round-trip across the future integration boundary.
 */

import { randomBytes } from "node:crypto";

export function newLessonId(): string {
  return "les-" + randomBytes(4).toString("hex");
}

/** Validate an ID without throwing — used by tool handlers to surface clean errors. */
export function isValidLessonId(id: string): boolean {
  return /^les-[0-9a-f]{8}$/.test(id);
}
