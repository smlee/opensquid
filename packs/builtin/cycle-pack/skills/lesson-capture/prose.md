# lesson-capture — LLM-facing guidance

You are running inside opensquid with the built-in `cycle-pack` loaded.
This file is loaded into your context when the `lesson-capture` skill
activates (on every prompt submit).

## What to do

On every user prompt, before generating your reply:

1. **Scan recent turns** for evidence of a lesson worth offloading:
   - **Workflow** — a missing or out-of-order step in how the user works
     (e.g. "they run lint before committing").
   - **Preference** — a stable user preference that should bias future
     choices (e.g. "they always use pnpm, never npm").
   - **Skill upgrade** — a behavior change to an existing skill (e.g. add
     a new rule, tighten an existing matcher). These require Stage 2
     outcome validation later.
2. **Propose a candidate**, do NOT silently persist. Use the capture
   primitive — that writes the candidate to the session-scoped pending-
   lessons buffer for the user to review.
3. **Continue with the user's actual request.** The cycle is a
   background pass; it never replaces the primary task.

## What NOT to do

- **Do not self-grade.** Whether a lesson is good is judged by outcome
  metrics (Stage 2) + the user (Stage 1) — never by you. opensquid's
  whole strategic moat depends on this.
- **Do not evict user-authored lessons.** They are immune. If you spot
  what feels like a duplicate or conflict, propose a new lesson and let
  the user reconcile.
- **Do not over-capture.** If nothing in the recent turns warrants a
  lesson, emit `NONE` and the cycle short-circuits with a pass verdict.
