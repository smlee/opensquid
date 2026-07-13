import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ToolCallEvent, ToolResultEvent } from './protocol.js';

import { PI_TOOL_CATALOG, type PiToolCapability } from './capability_catalog.js';
import {
  PiMultiEditError,
  applyOriginalRelativeMultiEdit,
  type MultiEditReplacement,
} from './multiedit.js';

export interface CanonicalToolCall {
  readonly toolCallId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly sourceTool: string;
  readonly mutationPath?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;

function resolvePath(pathText: string, cwd: string): string {
  return resolve(cwd, pathText);
}

function withFilePath(
  event: ToolCallEvent,
  canonicalTool: string,
  cwd: string,
  options: { reserveMutation?: boolean } = {},
): CanonicalToolCall {
  const input = asRecord(event.input) ?? {};
  const pathText = typeof input.path === 'string' ? input.path : '';
  const filePath = pathText === '' ? '' : resolvePath(pathText, cwd);
  return {
    toolCallId: event.toolCallId,
    tool: canonicalTool,
    args: { ...input, file_path: filePath },
    sourceTool: event.toolName,
    ...(options.reserveMutation === true && filePath !== '' ? { mutationPath: filePath } : {}),
  };
}

function canonicalToolName(
  toolName: string,
  catalog: readonly PiToolCapability[] = PI_TOOL_CATALOG,
): string {
  return catalog.find((tool) => tool.name === toolName)?.canonicalPolicyName ?? toolName;
}

export async function canonicalizeExactPiEdit(
  event: ToolCallEvent | ToolResultEvent,
  cwd: string,
): Promise<CanonicalToolCall> {
  const input = asRecord(event.input) ?? {};
  const pathText = typeof input.path === 'string' ? input.path : '';
  const filePath = pathText === '' ? '' : resolvePath(pathText, cwd);
  const edits = Array.isArray(input.edits)
    ? input.edits.map((edit) => {
        const parsed = asRecord(edit) ?? {};
        return {
          oldText: typeof parsed.oldText === 'string' ? parsed.oldText : '',
          newText: typeof parsed.newText === 'string' ? parsed.newText : '',
        } satisfies MultiEditReplacement;
      })
    : [];
  if (filePath === '') throw new PiMultiEditError('Pi MultiEdit path is required');
  const current = await readFile(filePath, 'utf8');
  applyOriginalRelativeMultiEdit(current, edits);
  return {
    toolCallId: event.toolCallId,
    tool: 'MultiEdit',
    args: {
      file_path: filePath,
      edits: edits.map((edit) => ({ old_string: edit.oldText, new_string: edit.newText })),
      replacement_semantics: 'original_unique_nonoverlap',
    },
    sourceTool: event.toolName,
    mutationPath: filePath,
  };
}

export async function canonicalizePiToolCall(
  event: ToolCallEvent,
  cwd: string,
  shell: { commandPrefix?: string; shellPath?: string } = {},
  catalog: readonly PiToolCapability[] = PI_TOOL_CATALOG,
): Promise<CanonicalToolCall> {
  if (event.toolName === 'edit') {
    return canonicalizeExactPiEdit(event, cwd);
  }
  if (event.toolName === 'write')
    return withFilePath(event, 'Write', cwd, { reserveMutation: true });
  if (event.toolName === 'read') return withFilePath(event, 'Read', cwd);
  if (event.toolName === 'grep') return withFilePath(event, 'Grep', cwd);
  if (event.toolName === 'bash') {
    const input = asRecord(event.input) ?? {};
    const command = typeof input.command === 'string' ? input.command : undefined;
    const effectiveCommand =
      command !== undefined && shell.commandPrefix ? `${shell.commandPrefix}\n${command}` : command;
    return {
      toolCallId: event.toolCallId,
      tool: 'Bash',
      args: {
        ...input,
        ...(effectiveCommand === undefined ? {} : { command: effectiveCommand }),
        ...(command === undefined || effectiveCommand === command
          ? {}
          : { source_command: command }),
        ...(shell.shellPath === undefined ? {} : { shell_path: shell.shellPath }),
      },
      sourceTool: event.toolName,
    };
  }
  return {
    toolCallId: event.toolCallId,
    tool: canonicalToolName(event.toolName, catalog),
    args: asRecord(event.input) ?? {},
    sourceTool: event.toolName,
  };
}
