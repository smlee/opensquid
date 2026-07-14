/** Minimal structural Pi extension contracts consumed by OpenSquid. */

export interface PiSessionManager {
  getSessionId(): string | undefined;
}

export interface ExtensionContext {
  readonly cwd: string;
  readonly sessionManager: PiSessionManager;
  readonly model?: { readonly provider: string; readonly id: string };
  abort(): void;
  readonly ui: {
    notify(message: string, level: string): void;
  };
}

export interface SessionStartEvent {
  readonly reason?: 'startup' | 'reload' | 'new' | 'resume' | 'fork';
}

export interface SessionShutdownEvent {
  readonly reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork';
  readonly targetSessionFile?: string;
}

export interface BeforeAgentStartEvent {
  readonly prompt: string;
  readonly systemPrompt: string;
}

export interface ToolCallEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface ToolResultEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly isError?: boolean;
}

export interface AgentEndEvent {
  readonly messages: readonly unknown[];
}

export interface PiToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly details: unknown;
  readonly isError?: boolean;
}

export interface PiToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<PiToolResult>;
}

type MaybePromise<T> = T | Promise<T>;

export interface ExtensionAPI {
  on(
    event: 'session_start',
    handler: (event: SessionStartEvent, ctx: ExtensionContext) => MaybePromise<unknown>,
  ): void;
  on(
    event: 'before_agent_start',
    handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => MaybePromise<unknown>,
  ): void;
  on(
    event: 'tool_call',
    handler: (event: ToolCallEvent, ctx: ExtensionContext) => MaybePromise<unknown>,
  ): void;
  on(
    event: 'tool_result',
    handler: (event: ToolResultEvent, ctx: ExtensionContext) => MaybePromise<unknown>,
  ): void;
  on(
    event: 'agent_end',
    handler: (event: AgentEndEvent, ctx: ExtensionContext) => MaybePromise<unknown>,
  ): void;
  on(
    event: 'session_shutdown',
    handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => MaybePromise<unknown>,
  ): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: { deliverAs: 'followUp' },
  ): Promise<unknown>;
  sendUserMessage(message: string, options: { deliverAs: 'followUp' }): Promise<unknown>;
  registerTool(definition: PiToolDefinition): void;
  registerCommand?(
    name: string,
    definition: {
      description: string;
      handler(args: string, ctx: ExtensionContext): MaybePromise<void>;
    },
  ): void;
}
