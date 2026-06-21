/**
 * Schema barrel — re-exports all six pack-config schemas.
 *
 * One file per pack-config YAML (manifest, models, channels, notifications,
 * drift_response, skill). Each schema module is self-contained (no
 * cross-imports between schemas) per Task 2.1 audit constraint; downstream
 * consumers go through this barrel.
 *
 * Source-of-truth field semantics: `docs/opensquid-real-design.md` §"Pack format"
 * + §"Manifest fields" + §"Skill format" + §"Drift response policies" +
 * §"Pluggable channels" + §"Notification routing".
 *
 * These schemas validate raw YAML INPUT; the parsed shapes match (and feed)
 * the runtime types in `src/runtime/types.ts`. Schemas + runtime types are
 * intentionally separate — schemas are the load boundary; runtime types are
 * the in-memory shape after merging manifest + sidecar config + skills.
 *
 * Re-export pattern: `export { X }` carries the Zod schema (value); the
 * inferred TS types of the same name are re-exported with `export type { X }`.
 * `verbatimModuleSyntax` requires the split so the emitted JS contains only
 * the value re-exports.
 */

// manifest.yaml
export {
  ActivationScope,
  BaseVersion,
  Capability,
  CompositeInclude,
  DetectedByCheck,
  Foundation,
  Manifest,
  ManifestScope,
  PackKind,
  PackUsage,
  PersonalRevision,
  Permissions,
  RateLimitPeriod,
  RateLimits,
  SeedLesson,
  VerifyGate,
  VerifyGateWhen,
} from './manifest.js';
export type {
  ActivationScope as ActivationScopeType,
  BaseVersion as BaseVersionType,
  Capability as CapabilityType,
  CompositeInclude as CompositeIncludeType,
  DetectedByCheck as DetectedByCheckType,
  FileWritePermission as FileWritePermissionType,
  Foundation as FoundationType,
  HttpRequestPermission as HttpRequestPermissionType,
  Manifest as ManifestType,
  ManifestScope as ManifestScopeType,
  PackKind as PackKindType,
  PackUsage as PackUsageType,
  PersonalRevision as PersonalRevisionType,
  Permissions as PermissionsType,
  RateLimitPeriod as RateLimitPeriodType,
  RateLimits as RateLimitsType,
  RateLimitTriggerConfig as RateLimitTriggerConfigType,
  SeedLesson as SeedLessonType,
  SendMessagePermission as SendMessagePermissionType,
  ShellExecPermission as ShellExecPermissionType,
  SubagentCallPermission as SubagentCallPermissionType,
  SubprocessCallPermission as SubprocessCallPermissionType,
  VerifyGate as VerifyGateType,
  VerifyGateWhen as VerifyGateWhenType,
} from './manifest.js';

// models.yaml
export { ModelAlias, ModelImpl, ModelMode, ModelsConfig } from './models.js';
export type {
  ModelAlias as ModelAliasType,
  ModelImpl as ModelImplType,
  ModelMode as ModelModeType,
  ModelsConfig as ModelsConfigType,
} from './models.js';

// channels.yaml
export { ChannelsConfig } from './channels.js';
export type { ChannelsConfig as ChannelsConfigType } from './channels.js';

// notifications.yaml
export { NotificationsConfig, Severity } from './notifications.js';
export type {
  NotificationsConfig as NotificationsConfigType,
  Severity as SeverityType,
} from './notifications.js';

// drift_response.yaml
export { DriftPolicyEnum, DriftResponseConfig } from './drift_response.js';
export type {
  DriftPolicyEnum as DriftPolicyEnumType,
  DriftResponseConfig as DriftResponseConfigType,
} from './drift_response.js';

// skill.yaml
export { LoadModeEnum, ProcessStep, Rule, RuleKindEnum, Skill } from './skill.js';
export type {
  LoadModeEnum as LoadModeEnumType,
  ProcessStep as ProcessStepType,
  Rule as RuleType,
  RuleKindEnum as RuleKindEnumType,
  Skill as SkillType,
} from './skill.js';

// team.yaml (Task 6.1 — Mode A team-pack manifest extension)
export { SubagentRole, Team } from './team.js';
export type { SubagentRole as SubagentRoleType, Team as TeamType } from './team.js';

// chat_agent.yaml (WAB.6 prep — chat-agent binding side-file schema)
export { BuiltinToolName, ChatAgentSchema } from './chat_agent.js';
export type {
  BuiltinToolName as BuiltinToolNameType,
  ChatAgentConfig as ChatAgentConfigType,
} from './chat_agent.js';

// worksheet.md authored block (T-scope-worksheet — the anti-drift checkpoint artifact)
export { Worksheet, WorksheetScope } from './worksheet.js';
export type { Worksheet as WorksheetType, WorksheetScope as WorksheetScopeType } from './worksheet.js';
