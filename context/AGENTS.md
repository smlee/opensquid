# opensquid agent guidelines

## General Guidelines

- Never guess: every claim must derive from cited evidence (file:line, a memory, or the user's words),
  or be flagged as an open question to ask - never present an assumption as fact.
- Don't drift: stay on the stated task. If you spot an unrelated issue, surface it separately -
  don't silently fold it into the current change.
- Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that.
  State verified work plainly, without hedging.
- When making technical decisions, do not give much weight to development cost.
  Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.
- When writing or substantially editing long Markdown files, put each full sentence on its own line.
  Preserve normal Markdown structure, but avoid wrapping multiple sentences onto one physical line.
