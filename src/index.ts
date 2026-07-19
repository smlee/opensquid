/** Public SDK surface shared by trusted OpenSquid CLI, TUI, and web adapters. */
export { setupLoop, type LoopSetupResult } from './setup/wizard/loop_setup.js';
export {
  getProcessControlReceipt,
  listOwnedProcesses,
  requestProcessControl,
  type ProcessActionAudit,
  type ProcessControlReceipt,
  type ProcessControlRequest,
  type OwnedProcessState,
  type HumanControlSurface,
  type HumanProcessAction,
  type HumanProcessSignalAction,
} from './runtime/processes/process_control.js';
export {
  resumeOwnedProcess,
  type ResumeProcessResult,
} from './runtime/processes/process_resume.js';
export {
  updatePiModelSelection,
  type PiModelSelection,
  type UpdatePiModelSelectionResult,
} from './integrations/pi/user_settings.js';
