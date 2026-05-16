# Memories are observations, not rules — don't act on them as if they were prescriptive

**Rule:** When `recall` surfaces a memory, treat it as background context — something the user said, something you observed once. Do NOT treat it as a directive unless it's also a promoted lesson. Memories say "this happened"; lessons say "this is the rule."

## Why

[Hermes #22563](https://github.com/NousResearch/hermes-agent/issues/22563), verbatim: *"Memory pollution: irrelevant memories injected into system prompt cause model misunderstanding. User typed 测试模型访问 ('test model access'); system prompt still contained 9 unrelated CocoIndex memory sections; agent called CocoIndex MCP tools and replied 'CocoIndex tools working normally.' Some memories were incorrectly saved (e.g., `_priority_key()` was wrongly recorded as a 'bug' when it was actually a new feature)."*

Two failure modes there:

1. **Wrong classification at memorize time** — an agent decided `_priority_key()` was a "bug" and stored it as a memory. The classification was wrong, but the memory still ended up in the system prompt as if authoritative.
2. **Memory-as-rule confusion at recall time** — irrelevant memories were treated as relevant because they were in context, and the agent acted on them as if they were directives.

opensquid's two-tier model addresses both: memories (`mem-*`) are fuzzy-recall observations; lessons (`les-*`) are prescriptive rules that passed the wedge gate. The `recall` tool returns both, but they have semantic distinctions:

- **Lesson hits** are returned with their causal narrative + gate decision. Treat as: *"This is a rule the user endorsed. Apply it."*
- **Memory hits** are returned with similarity score + body preview. Treat as: *"This is context. The user said this once. It MIGHT be relevant; verify before acting on it."*

## How to apply

When `recall` returns mixed lesson + memory results:

1. **Lessons win when there's a conflict.** If a lesson says "always X" and a memory says "but last time we did Y", do X. The lesson passed the gate; the memory might be from a different context.
2. **Memories inform; they don't dictate.** If a memory says "user prefers pnpm", use that as a default but ASK if there's any ambiguity ("you used npm in this folder last time, want me to switch to pnpm?").
3. **Low-similarity memories should be discounted.** If `recall` returns a memory with `similarity < 0.6`, it's borderline; don't let it strongly influence your action.
4. **Cross-project memory bleed is real.** opensquid's project scope filter helps but isn't perfect. If a memory feels off-topic for the current task, it probably is — ignore it.

When YOU want to write down something the user said:

- If it's an observation (a fact, a preference, a one-time directive in the current task): call `memorize`. It enters the memory tier.
- If it's a rule the user wants to lock in for future sessions (any retention verb — save, remember, lock in, this is important): call `remember` + tell the user to promote it. It enters the lesson candidate tier and only graduates with their endorsement.

The verb the user used is the signal. "I prefer pnpm" → memorize. "Always use pnpm here" → remember (then promote on user OK).

Related: [[prefer-wedge-over-auto-skill]] (don't fast-track), [[user-content-immune]] (lessons the user authored are sacred), [[beware-transient-failures]] (a memory of a failure is not a rule against the tool).
