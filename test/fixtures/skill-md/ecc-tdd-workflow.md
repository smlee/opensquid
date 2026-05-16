---
name: tdd-workflow
description: ECC-style TDD workflow with red-green-refactor cycles and explicit test-watching discipline.
origin: ECC
---

# TDD Workflow (ECC)

The everything-claude-code variant of TDD discipline. Emphasizes:

- Test names that describe behavior, not implementation
- One assertion per test where possible
- No mocks for code you control — only at system boundaries
- The failing test message IS the spec
