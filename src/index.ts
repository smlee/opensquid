/** Public SDK surface shared by trusted OpenSquid CLI, TUI, and web adapters. */
export { setupLoop, type LoopSetupResult } from './setup/wizard/loop_setup.js';
export {
  getExecutorControlReceipt,
  listExecutorProcesses,
  requestExecutorControl,
  type ExecutorActionAudit,
  type ExecutorControlReceipt,
  type ExecutorControlRequest,
  type ExecutorProcessState,
  type HumanControlSurface,
  type HumanExecutorAction,
  type HumanProcessSignalAction,
} from './runtime/subagents/process_control.js';
export {
  resumeExecutorProcess,
  type ResumeExecutorResult,
} from './runtime/subagents/process_resume.js';
export {
  updatePiModelSelection,
  type PiModelSelection,
  type UpdatePiModelSelectionResult,
} from './integrations/pi/user_settings.js';
