# pack-architect

opensquid's meta-discipline pack: **teaches users how to author well-formed
opensquid packs**. Ships in dual-mode (`usage: both`):

- **Active**: the 3 skills fire inline while you're editing pack-config
  files (manifest.yaml / skill.yaml) and surface authoring checklists.
- **Profession**: when another pack emits
  `next_action.profession: pack-architect`, the agent spawns a
  pack-architect subagent that walks you through a full 4-phase
  pack-authoring session.

## Opt in (NOT loaded by default)

```json
{ "packs": ["default-discipline", "pack-architect"] }
```

Per BR.1, opensquid never auto-imposes discipline. Add pack-architect to
your `~/.opensquid/active.json` (or project-scope `.opensquid/active.json`)
when you want it.

Pack-architect works best when **scope-architect is also opted in** — the
pack-scope-elicit skill emits chain-handoff directives to scope-architect
for prework. Without scope-architect loaded, the MM.2 profession resolver
will drop those directives + log them; the user's prompt is unaffected
but the chain-handoff stalls.

## The 3 skills

| Skill                           | When it fires                                                          | What it does                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pack-scope-elicit`             | UserPromptSubmit matches pack-authoring intent + chain stage is `idle` | Emits directive `next_action.profession: scope-architect` for prework                          |
| `manifest-author-walkthrough`   | PreToolUse Edit/Write of `packs/*/manifest.yaml`                       | Surface verdict with manifest-field checklist (cites pack-runtime.md §1)                       |
| `skill-yaml-author-walkthrough` | PreToolUse Edit/Write of `packs/*/skills/*/skill.yaml`                 | Surface verdict with skill-field checklist (cites pack-runtime.md §2 + skill-grammar-guide.md) |

## The 4-phase pack-authoring workflow (when spawned as profession)

1. **Identify scope + persona** — kind/usage decisions, detected_by
   choice, activation_scope.
2. **Write manifest.yaml** — required + recommended fields per pack-runtime.md §1.
3. **Author skills** — one skill per rule kind; when_to_load + triggers
   - rules + process steps; verdict choice; if: grammar discipline.
4. **Side-files** — team.yaml only if profession-mode; other side files
   only as needed.

## References

- `docs/pack-runtime.md` — the authoritative reference pack-architect
  cites throughout.
- `docs/skill-grammar-guide.md` — companion doc for the `if:` grammar.
- `packs/builtin/default-discipline/` — canonical built-in with rich
  foundation/detected_by populated.
- `packs/builtin/scope-architect/` — canonical profession-mode-eligible
  pack (chain-handoff target).
- `packs/builtin/task-spec-author/` — canonical pure-profession pack.

## Customizing

The 3 surface-verdict checklists can be too noisy for active pack
authoring (every Edit fires). If that becomes an issue:

- Move the skill to `load: lazy` + add a more specific
  `when_to_load: chain_stage: ...` matcher
- Or copy the skill into your own pack with a project-specific
  `detected_by:` clause limiting WHEN it activates

Pack-architect IS the canonical example of a well-authored pack — it's
designed to be copied + adapted, not just consumed.
