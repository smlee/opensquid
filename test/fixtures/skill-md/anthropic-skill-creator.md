---
name: skill-creator
description: Use when creating, updating, or packaging a new Claude Skill — guides directory layout, frontmatter authorship, and progressive disclosure patterns.
---

# Skill Creator

Use this skill when you need to scaffold a new Claude Skill following Anthropic's official authoring guidelines.

## Directory layout

```
my-skill/
├── SKILL.md          # required — frontmatter + body
├── examples/         # optional reference material
└── scripts/          # optional helper scripts
```

## Frontmatter rules

- `name`: lowercase, `[a-z0-9-]`, max 64 chars
- `description`: single-line, max 1024 chars
- `license`: optional SPDX identifier

## Progressive disclosure

Body should start with the cheapest path (what to do in 80% of cases) and only dive into edge cases below a horizontal rule.
