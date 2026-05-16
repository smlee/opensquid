---
name: test-driven-development
description: Use when writing new code or modifying existing behavior — write a failing test first, watch it fail with the expected message, write the minimum code to make it pass, then refactor.
---

# Test-Driven Development

The TDD loop is **red → green → refactor**, and the most-skipped step is watching the red. If you didn't see the failure message, you didn't actually verify the test exercises the new behavior.

## When to apply

- Adding a new function, method, or endpoint
- Fixing a bug (write the regression test first — it MUST fail before the fix)
- Changing the contract of an existing function

## When NOT to apply

- Pure refactors with no behavior change (tests should pass before AND after)
- Throwaway scripts that won't be re-run
- Spike code where you don't yet know the shape of the API

## The minimum

Each cycle:
1. Write ONE test that captures the next small behavior
2. Run it. See it fail. Read the failure message.
3. Write the minimum code that flips it green
4. Refactor with the safety net of the green test

If steps 2 or 3 take longer than 10 minutes, the test is too big — split it.
