import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalizePiToolCall } from './canonicalize.js';

let cwd = '';

afterEach(async () => {
  if (cwd !== '') await rm(cwd, { recursive: true, force: true });
  cwd = '';
});

async function makeCwd(): Promise<string> {
  cwd = await mkdtemp(join(tmpdir(), 'opensquid-pi-canonicalize-'));
  return cwd;
}

describe('canonicalizePiToolCall', () => {
  it('maps built-in tools to canonical policy names with cwd-relative file paths and reserves only writes', async () => {
    const dir = await makeCwd();
    await writeFile(join(dir, 'note.md'), 'hello\n');
    const readCall = await canonicalizePiToolCall(
      { type: 'tool_call', toolCallId: '1', toolName: 'read', input: { path: 'note.md' } } as never,
      dir,
    );
    const grepCall = await canonicalizePiToolCall(
      {
        type: 'tool_call',
        toolCallId: '2',
        toolName: 'grep',
        input: { path: 'note.md', pattern: 'hello' },
      } as never,
      dir,
    );
    const writeCall = await canonicalizePiToolCall(
      {
        type: 'tool_call',
        toolCallId: '3',
        toolName: 'write',
        input: { path: 'note.md', content: 'next' },
      } as never,
      dir,
    );
    expect(readCall).toMatchObject({
      tool: 'Read',
      args: { file_path: join(dir, 'note.md'), path: 'note.md' },
    });
    expect(readCall).not.toHaveProperty('mutationPath');
    expect(grepCall).toMatchObject({
      tool: 'Grep',
      args: { file_path: join(dir, 'note.md'), path: 'note.md', pattern: 'hello' },
    });
    expect(grepCall).not.toHaveProperty('mutationPath');
    expect(writeCall).toMatchObject({
      tool: 'Write',
      mutationPath: join(dir, 'note.md'),
      args: { file_path: join(dir, 'note.md'), path: 'note.md', content: 'next' },
    });
  });

  it('maps MCP tools from the catalog', async () => {
    const dir = await makeCwd();
    const call = await canonicalizePiToolCall(
      {
        type: 'tool_call',
        toolCallId: 'm1',
        toolName: 'workgraph_get',
        input: { id: 'wg-1' },
      } as never,
      dir,
    );
    expect(call.tool).toBe('mcp__opensquid__workgraph_get');
  });

  it('projects the effective prefixed Bash command that Pi executes', async () => {
    const dir = await makeCwd();
    const call = await canonicalizePiToolCall(
      {
        toolCallId: 'b1',
        toolName: 'bash',
        input: { command: 'pnpm test' },
      },
      dir,
      { commandPrefix: 'source .envrc', shellPath: '/bin/zsh' },
    );
    expect(call).toMatchObject({
      tool: 'Bash',
      args: {
        command: 'source .envrc\npnpm test',
        source_command: 'pnpm test',
        shell_path: '/bin/zsh',
      },
    });
  });

  it('canonicalizes edit into exact MultiEdit semantics', async () => {
    const dir = await makeCwd();
    await writeFile(join(dir, 'edit.txt'), 'alpha\r\nbeta\r\n');
    const call = await canonicalizePiToolCall(
      {
        type: 'tool_call',
        toolCallId: 'e1',
        toolName: 'edit',
        input: {
          path: 'edit.txt',
          edits: [{ oldText: 'beta', newText: 'BETA' }],
        },
      } as never,
      dir,
    );
    expect(call).toMatchObject({
      tool: 'MultiEdit',
      mutationPath: join(dir, 'edit.txt'),
      args: {
        file_path: join(dir, 'edit.txt'),
        replacement_semantics: 'original_unique_nonoverlap',
        edits: [{ old_string: 'beta', new_string: 'BETA' }],
      },
    });
  });
});
