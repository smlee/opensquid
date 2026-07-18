/** Shared bounds and result shapes for optional bounded reviewer fan-out. */

export const MAX_SUBAGENT_RESULT_BYTES = 50 * 1024;

export interface SubagentRunResult<TDetails = unknown> {
  readonly role: string;
  readonly text: string;
  readonly isError: boolean;
  readonly details?: TDetails;
}

export interface SubagentBatchResult<TDetails = unknown> {
  readonly results: readonly SubagentRunResult<TDetails>[];
}
