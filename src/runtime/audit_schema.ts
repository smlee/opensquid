import { z } from 'zod';

export const AUDIT_LENS_MIN = 2;
export const AUDIT_LENS_MAX = 4;
export const MAX_AUDIT_TEXT_BYTES = 300_000;
export const MAX_AUDIT_CRITERIA = 16;
export const MAX_AUDIT_CRITERION_BYTES = 4_096;

/** Shared scalar grammar used by declaration, persisted evidence, and aggregation. */
export const AuditLensIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
export const AuditVerdictTokenSchema = z.string().regex(/^[A-Z][A-Z_]{0,63}$/u);

export function distinctAuditVerdicts(passVerdict: string, failVerdict: string): boolean {
  return passVerdict !== failVerdict;
}
