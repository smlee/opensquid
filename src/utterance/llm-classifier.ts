/**
 * LLM-driven utterance classifier — runs in the detached Stop-hook
 * subprocess to auto-observe what the user said.
 *
 * Calls a local Ollama chat model (default `llama3.2:3b`) with a
 * structured-output prompt. The response is Zod-validated and any
 * hallucinated items (text not a substring of the user's utterance)
 * are dropped.
 *
 * Fail-open: timeout, connection refused, or schema failure all
 * resolve to `{ utterances: [] }`. The hook caller must not crash.
 *
 * Provider override via `OPENSQUID_CLASSIFIER_PROVIDER`:
 *   - `ollama` (default) — local HTTP at `OLLAMA_HOST` or `localhost:11434`
 *   - `off` — return empty without making a network call
 * Future: `anthropic` (opt-in, requires ANTHROPIC_API_KEY).
 */

import { z } from "zod";

// ---------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------

export const UtteranceKindSchema = z.enum(["fact", "preference", "correction", "workflow_lock"]);
export const UtteranceConfidenceSchema = z.enum(["high", "medium", "low"]);
export const SuggestedToolSchema = z.enum(["memorize", "remember", "update_memory"]);

export const ClassifiedUtteranceSchema = z.object({
  kind: UtteranceKindSchema,
  text: z.string().min(1),
  confidence: UtteranceConfidenceSchema,
  reasoning: z.string().min(1),
  suggested_tool: SuggestedToolSchema,
  suggested_args: z.object({
    description: z.string().min(1),
    content: z.string().min(1),
  }),
});
export type ClassifiedUtterance = z.infer<typeof ClassifiedUtteranceSchema>;

export const ClassifierResponseSchema = z.object({
  utterances: z.array(ClassifiedUtteranceSchema),
});
export type ClassifierResponse = z.infer<typeof ClassifierResponseSchema>;

// ---------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a memory classifier for opensquid, a memory layer for AI agents. Read the USER'S utterance and identify SUBSTANTIVE items worth persisting.

Emit JSON only. Schema:
{
  "utterances": [
    {
      "kind": "fact" | "preference" | "correction" | "workflow_lock",
      "text": "<EXACT VERBATIM SUBSTRING of the user's utterance>",
      "confidence": "high" | "medium" | "low",
      "reasoning": "<one short sentence>",
      "suggested_tool": "memorize" | "remember" | "update_memory",
      "suggested_args": {
        "description": "<short summary, ≤120 chars>",
        "content": "<full content to store>"
      }
    }
  ]
}

Kinds:
- fact: stable observation about the user, their tools, or environment (e.g., "I use pnpm")
- preference: a directive or rule (e.g., "I prefer kebab-case", "always run tests first")
- correction: correction of a prior statement (e.g., "no that's wrong", "actually it should be X")
- workflow_lock: an ordering rule (e.g., "the workflow is X→Y→Z", "no hedges")

Tool suggestion:
- fact → memorize
- preference / workflow_lock → remember (lesson candidate; user will promote)
- correction → memorize (and possibly update_memory, which we surface for review)

Rules:
- Questions, greetings, small talk, transient instructions → empty array.
- The "text" field MUST be a verbatim substring of the user's utterance.
- One utterance can produce multiple items if it has multiple substantive claims.
- Output JSON only. No prose. No backticks. No leading whitespace.

If nothing substantive: { "utterances": [] }`;

// ---------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------

export interface ClassifyOptions {
  /** Provider override; defaults to env or "ollama". */
  provider?: "ollama" | "off";
  /** Ollama model id; defaults to env `OPENSQUID_CLASSIFIER_MODEL` or "llama3.2:3b". */
  model?: string;
  /** Ollama host URL; defaults to env `OLLAMA_HOST` or "http://localhost:11434". */
  host?: string;
  /** Hard timeout ms; defaults to 1500. */
  timeoutMs?: number;
}

/**
 * Classify the user's most recent utterance. Returns `{ utterances: [] }`
 * on any failure (network, parse, schema, timeout). Caller never sees an
 * exception unless the input is invalid.
 */
export async function classifyWithLLM(
  userText: string,
  options: ClassifyOptions = {},
): Promise<ClassifierResponse> {
  if (!userText || !userText.trim()) {
    return { utterances: [] };
  }
  const provider =
    options.provider ??
    (process.env.OPENSQUID_CLASSIFIER_PROVIDER as "ollama" | "off" | undefined) ??
    "ollama";
  if (provider === "off") {
    return { utterances: [] };
  }

  const timeoutMs = options.timeoutMs ?? 1500;
  const raw = await Promise.race([callOllama(userText, options), timeoutAfter(timeoutMs)]);
  if (raw === null) return { utterances: [] };

  const parsed = safeParseJson(raw);
  if (!parsed) return { utterances: [] };

  // #112-audit finding 10: validate each utterance INDIVIDUALLY. A
  // single bad item used to drop the whole batch; now we drop only the
  // bad ones and keep the rest.
  const envelope = OuterEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) return { utterances: [] };

  const valid: ClassifiedUtterance[] = [];
  for (const candidate of envelope.data.utterances) {
    const item = ClassifiedUtteranceSchema.safeParse(candidate);
    if (!item.success) continue;
    // Hallucination guard: text MUST be a verbatim substring of the
    // user's utterance. Caps + injection markers are handled by the
    // caller (auto-classify) so the classifier stays a pure parser.
    if (!userText.includes(item.data.text)) continue;
    valid.push(item.data);
  }
  return { utterances: valid };
}

const OuterEnvelopeSchema = z.object({ utterances: z.array(z.unknown()) });

// ---------------------------------------------------------------------
// Ollama transport
// ---------------------------------------------------------------------

interface OllamaChatResponse {
  message?: { content?: string };
}

async function callOllama(userText: string, options: ClassifyOptions): Promise<string | null> {
  const host = options.host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = options.model ?? process.env.OPENSQUID_CLASSIFIER_MODEL ?? "llama3.2:3b";
  const url = `${host.replace(/\/$/, "")}/api/chat`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userText },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as OllamaChatResponse;
    return body.message?.content ?? null;
  } catch {
    return null;
  }
}

function timeoutAfter(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
