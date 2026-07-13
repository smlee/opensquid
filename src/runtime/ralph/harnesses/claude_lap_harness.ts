/** Claude one-shot lap adapter. Vendor invocation/envelope literals stay here. */
import type {
  ClaudeHarnessConfig,
  LapEnvelope,
  LapHarness,
  LapHarnessCfg,
} from '../lap_harness.js';

function readUsage(env: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  const usage = env.usage;
  if (usage === null || typeof usage !== 'object') return { inputTokens: 0, outputTokens: 0 };
  const rec = usage as Record<string, unknown>;
  return {
    inputTokens: typeof rec.input_tokens === 'number' ? rec.input_tokens : 0,
    outputTokens: typeof rec.output_tokens === 'number' ? rec.output_tokens : 0,
  };
}

const spawnArgs = (cfg: Pick<LapHarnessCfg, 'maxBudgetUsd'>): string[] => [
  '-p',
  '--output-format',
  'json',
  '--max-budget-usd',
  String(cfg.maxBudgetUsd),
  '--dangerously-skip-permissions',
];

const parseEnvelope = (stdout: string, _stderr = ''): LapEnvelope => {
  let env: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== 'object')
      return { resultText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, isError: true };
    env = parsed as Record<string, unknown>;
  } catch {
    return { resultText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, isError: true };
  }
  const usage = readUsage(env);
  return {
    resultText: typeof env.result === 'string' ? env.result : '',
    costUsd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd : 0,
    ...usage,
    isError: env.is_error === true,
  };
};

export const claudeLapHarness: LapHarness<ClaudeHarnessConfig> & {
  spawnArgs: typeof spawnArgs;
  deliverPrompt(prompt: string): { stdin: string };
  parseEnvelope(stdout: string, stderr: string): LapEnvelope;
} = {
  kind: 'claude',
  spawnArgs,
  deliverPrompt: (prompt) => ({ stdin: prompt }),
  parseEnvelope,
  async run(request, config, deps): Promise<LapEnvelope> {
    let stderr = '';
    const stdout = await deps.runOneShot({
      cli: config.cli,
      args: spawnArgs(config),
      prompt: request.prompt,
      timeoutMs: request.timeoutMs,
      env: request.env,
      timeoutError: () => Object.assign(new Error('lap timeout'), { __timeout: true }),
      ...(request.onStderrLine === undefined ? {} : { onStderrLine: request.onStderrLine }),
      onStreams: (streams) => {
        stderr = streams.stderr;
        request.onStreams?.(streams);
      },
    });
    return parseEnvelope(stdout, stderr);
  },
};
