/**
 * Tests for `chat_agent.yaml` schema.
 *
 * Coverage matches the WAB.6 spec §"Test fixtures" line items:
 *   - minimum valid YAML (only `default_model`) → parses with defaults applied
 *   - full YAML with skills + disable_builtins + tunables → preserves values
 *   - `disable_builtins: [bogus_name]` → fails enum validation
 *   - unknown top-level field (typo `skllls:`) → strict mode rejects
 *
 * Plus edge cases: missing required `default_model`, empty-string
 * `default_model`, tunable out-of-range, accept-all three built-in names.
 */

import { describe, expect, it } from 'vitest';

import { BuiltinToolName, ChatAgentSchema } from './chat_agent.js';

describe('ChatAgentSchema', () => {
  it('parses minimum-viable input with only default_model + applies all defaults', () => {
    const result = ChatAgentSchema.parse({ default_model: 'fast_chat' });
    expect(result.default_model).toBe('fast_chat');
    expect(result.system_prompt).toBeUndefined();
    expect(result.skills).toEqual([]);
    expect(result.disable_builtins).toEqual([]);
    expect(result.max_tool_iterations).toBe(8);
    expect(result.max_tokens).toBe(1024);
  });

  it('preserves user values for a full declaration', () => {
    const result = ChatAgentSchema.parse({
      default_model: 'reasoning',
      system_prompt: 'prompts/chat.md',
      skills: ['subagent_call', 'llm_classify'],
      disable_builtins: ['recall'],
      max_tool_iterations: 16,
      max_tokens: 4096,
    });
    expect(result.default_model).toBe('reasoning');
    expect(result.system_prompt).toBe('prompts/chat.md');
    expect(result.skills).toEqual(['subagent_call', 'llm_classify']);
    expect(result.disable_builtins).toEqual(['recall']);
    expect(result.max_tool_iterations).toBe(16);
    expect(result.max_tokens).toBe(4096);
  });

  it('rejects an unknown built-in name in disable_builtins', () => {
    const result = ChatAgentSchema.safeParse({
      default_model: 'fast_chat',
      disable_builtins: ['bogus_name'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('disable_builtins'))).toBe(true);
    }
  });

  it('rejects an unknown top-level key (strict mode)', () => {
    const result = ChatAgentSchema.safeParse({
      default_model: 'fast_chat',
      skllls: ['oops'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('rejects missing required default_model', () => {
    const result = ChatAgentSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('default_model'))).toBe(true);
    }
  });

  it('rejects an empty-string default_model', () => {
    const result = ChatAgentSchema.safeParse({ default_model: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('default_model'))).toBe(true);
    }
  });

  it('accepts all three built-in names in disable_builtins (full opt-out)', () => {
    const result = ChatAgentSchema.parse({
      default_model: 'fast_chat',
      disable_builtins: ['chat_send', 'recall', 'store_lesson'],
    });
    expect(result.disable_builtins).toEqual(['chat_send', 'recall', 'store_lesson']);
  });

  it('rejects max_tool_iterations above the upper bound (32)', () => {
    const result = ChatAgentSchema.safeParse({
      default_model: 'fast_chat',
      max_tool_iterations: 64,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('max_tool_iterations'))).toBe(true);
    }
  });

  it('rejects max_tool_iterations below 1', () => {
    const result = ChatAgentSchema.safeParse({
      default_model: 'fast_chat',
      max_tool_iterations: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer max_tool_iterations', () => {
    const result = ChatAgentSchema.safeParse({
      default_model: 'fast_chat',
      max_tool_iterations: 4.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects max_tokens above 8192', () => {
    const result = ChatAgentSchema.safeParse({
      default_model: 'fast_chat',
      max_tokens: 16000,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('max_tokens'))).toBe(true);
    }
  });

  it('rejects max_tokens below 64', () => {
    const result = ChatAgentSchema.safeParse({
      default_model: 'fast_chat',
      max_tokens: 32,
    });
    expect(result.success).toBe(false);
  });
});

describe('BuiltinToolName enum', () => {
  it('accepts the three sealed built-in names', () => {
    expect(BuiltinToolName.parse('chat_send')).toBe('chat_send');
    expect(BuiltinToolName.parse('recall')).toBe('recall');
    expect(BuiltinToolName.parse('store_lesson')).toBe('store_lesson');
  });

  it('rejects an unknown built-in name', () => {
    expect(BuiltinToolName.safeParse('subagent_call').success).toBe(false);
  });
});
