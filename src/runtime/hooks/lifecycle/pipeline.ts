import { runPostToolCall } from './post_tool_call.js';
import { runPreToolCall } from './pre_tool_call.js';
import { runPromptSubmit } from './prompt_submit.js';
import { runSessionEnd } from './session_end.js';
import { runSessionStart } from './session_start.js';
import { runStop } from './stop.js';
import type {
  LifecycleContext,
  LifecycleOutput,
  LifecyclePipeline,
  PostToolCallInput,
  PreToolDecision,
  PromptSubmitInput,
  SessionEndInput,
  SessionStartInput,
  StopInput,
  ToolCallInput,
} from './types.js';

export class DefaultLifecyclePipeline implements LifecyclePipeline {
  runSessionStart(input: SessionStartInput, ctx: LifecycleContext): Promise<LifecycleOutput> {
    return runSessionStart(input, ctx);
  }

  runPromptSubmit(input: PromptSubmitInput, ctx: LifecycleContext): Promise<LifecycleOutput> {
    return runPromptSubmit(input, ctx);
  }

  runPreToolCall(input: ToolCallInput, ctx: LifecycleContext): Promise<PreToolDecision> {
    return runPreToolCall(input, ctx);
  }

  runPostToolCall(input: PostToolCallInput, ctx: LifecycleContext): Promise<LifecycleOutput> {
    return runPostToolCall(input, ctx);
  }

  runStop(input: StopInput, ctx: LifecycleContext) {
    return runStop(input, ctx);
  }

  runSessionEnd(input: SessionEndInput, ctx: LifecycleContext): Promise<LifecycleOutput> {
    return runSessionEnd(input, ctx);
  }
}

export const defaultLifecyclePipeline: LifecyclePipeline = new DefaultLifecyclePipeline();
