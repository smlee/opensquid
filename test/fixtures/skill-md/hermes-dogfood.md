---
name: dogfood
description: Use Hermes Agent to test itself — invoke Hermes from within a Hermes session to validate new skill packs end-to-end before publishing.
version: 0.3.1
author: Hermes Team
license: MIT
platforms:
  - claude-code
  - cursor
  - hermes
metadata:
  hermes:
    tags:
      - testing
      - self-test
      - publishing
    related_skills:
      - publish-skill
      - skill-validator
---

# Dogfood

Run the to-be-published skill inside an existing Hermes session and exercise it end-to-end. If the skill needs a tool the host doesn't provide, the dogfood session must surface that gap before publish.

## Checklist before publishing

- [ ] All `tools:` in frontmatter exist on every listed `platforms:` host
- [ ] At least one synthetic test prompt has run the skill through green
- [ ] Skill body has no platform-specific assumptions that violate the `platforms:` list
- [ ] `related_skills:` actually exist in the registry
