import type { SubagentRole } from './types.js';

export function safeSubagentSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}

export function generatedSubagentRoleName(pack: string, roleName: string): string {
  return `opensquid-${safeSubagentSlug(pack)}-${safeSubagentSlug(roleName)}`;
}

export function renderSubagentRoleMarkdown(
  role: Pick<SubagentRole, 'generatedName' | 'description' | 'tools' | 'model' | 'systemPrompt'>,
): string {
  const frontmatter = [
    '---',
    `name: ${role.generatedName}`,
    `description: ${JSON.stringify(role.description)}`,
    `tools: ${role.tools.join(', ')}`,
    ...(role.model === undefined ? [] : [`model: ${role.model}`]),
    '---',
    '',
  ].join('\n');
  return `${frontmatter}${role.systemPrompt}`;
}
