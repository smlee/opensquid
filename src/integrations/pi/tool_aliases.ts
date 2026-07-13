export interface PolicyToolValue {
  readonly __opensquidPolicyToolValue: true;
  readonly actual: string;
  readonly aliases: readonly string[];
}

const TOOL_ALIASES = new Map<string, readonly string[]>([['MultiEdit', ['MultiEdit', 'Edit']]]);

const asPolicyToolValue = (value: unknown): PolicyToolValue | null => {
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as { __opensquidPolicyToolValue?: unknown }).__opensquidPolicyToolValue === true &&
    typeof (value as { actual?: unknown }).actual === 'string' &&
    Array.isArray((value as { aliases?: unknown }).aliases)
  ) {
    return value as PolicyToolValue;
  }
  return null;
};

const uniqueAliases = (tool: string): readonly string[] => {
  const configured = TOOL_ALIASES.get(tool);
  if (configured === undefined) return [tool];
  return [...new Set([tool, ...configured])];
};

export function policyToolAliases(tool: string): ReadonlySet<string> {
  return new Set(uniqueAliases(tool));
}

export function toPolicyToolValue(tool: string): string | PolicyToolValue {
  const aliases = uniqueAliases(tool);
  if (aliases.length === 1) return tool;
  return Object.freeze({
    __opensquidPolicyToolValue: true as const,
    actual: tool,
    aliases,
  });
}

export function policyToolActualName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return asPolicyToolValue(value)?.actual ?? null;
}

export function toolValueString(value: unknown): string | null {
  return policyToolActualName(value);
}

export function toolMatches(actual: string, expected: string | RegExp): boolean {
  const aliases = uniqueAliases(actual);
  if (typeof expected === 'string') return aliases.includes(expected);
  return aliases.some((name) => {
    expected.lastIndex = 0;
    return expected.test(name);
  });
}

export function toolValueEquals(lhs: unknown, rhs: unknown): boolean | null {
  const left = asPolicyToolValue(lhs);
  if (left !== null) {
    const rightText = policyToolActualName(rhs);
    return rightText === null ? false : toolMatches(left.actual, rightText);
  }
  const right = asPolicyToolValue(rhs);
  if (right !== null) {
    const leftText = policyToolActualName(lhs);
    return leftText === null ? false : toolMatches(right.actual, leftText);
  }
  return null;
}

function withToolAliases(subject: unknown, match: (name: string) => boolean): boolean | null {
  const tool = asPolicyToolValue(subject);
  if (tool === null) return null;
  return tool.aliases.some(match);
}

export function toolValueContains(subject: unknown, needle: string): boolean | null {
  return withToolAliases(subject, (name) => name.includes(needle));
}

export function toolValueStartsWith(subject: unknown, prefix: string): boolean | null {
  return withToolAliases(subject, (name) => name.startsWith(prefix));
}

export function toolValueEndsWith(subject: unknown, suffix: string): boolean | null {
  return withToolAliases(subject, (name) => name.endsWith(suffix));
}

export function toolValueMatchesPattern(
  subject: unknown,
  pattern: { test(input: string): boolean; lastIndex?: number },
): boolean | null {
  return withToolAliases(subject, (name) => {
    if ('lastIndex' in pattern && typeof pattern.lastIndex === 'number') pattern.lastIndex = 0;
    return pattern.test(name);
  });
}
