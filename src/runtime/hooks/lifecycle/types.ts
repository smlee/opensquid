import type { Directive } from '../../types.js';
import type {
  PostToolCallEvent,
  PromptSubmitEvent,
  SessionEndEvent,
  SessionStartEvent,
  StopEvent,
  ToolCallEvent,
} from '../../event.js';

export type Actor = { kind: 'orchestrator' } | { kind: 'executor'; id: string };
export type LifecycleRole = 'interactive' | 'lap-parent' | 'lap-child';

export interface LifecycleContext {
  sessionId: string;
  /** Explicit durable item identity for autonomous laps, distinct from session identity. */
  itemId?: string;
  cwd: string;
  actor: Actor;
  role: LifecycleRole;
  now: string;
}

export interface LifecycleOutput {
  exitCode: 0 | 2;
  stderr: string;
  contextInjections: string[];
  directives: Directive[];
  diagnostics: string[];
}

export interface SessionStartInput {
  event: SessionStartEvent;
}

export interface PromptSubmitInput {
  event: PromptSubmitEvent;
}

export interface ToolCallInput {
  event: ToolCallEvent;
  transcriptPath?: string;
}

export interface PreToolDecision {
  block: boolean;
  reason?: string;
  contextInjections: string[];
  diagnostics: string[];
}

export interface PostToolCallInput {
  event: PostToolCallEvent;
}

export interface StopInput {
  event: StopEvent;
  raw?: string;
  isLoopLap: boolean;
}

export interface StopOutput extends LifecycleOutput {
  continuationReason?: string;
}

export interface SessionEndInput {
  event: SessionEndEvent;
  isLoopLap: boolean;
}

export interface LifecyclePipeline {
  runSessionStart(input: SessionStartInput, ctx: LifecycleContext): Promise<LifecycleOutput>;
  runPromptSubmit(input: PromptSubmitInput, ctx: LifecycleContext): Promise<LifecycleOutput>;
  runPreToolCall(input: ToolCallInput, ctx: LifecycleContext): Promise<PreToolDecision>;
  runPostToolCall(input: PostToolCallInput, ctx: LifecycleContext): Promise<LifecycleOutput>;
  runStop(input: StopInput, ctx: LifecycleContext): Promise<StopOutput>;
  runSessionEnd(input: SessionEndInput, ctx: LifecycleContext): Promise<LifecycleOutput>;
}
