# 🦑 opensquid

> **Pass the gate, or get eliminated.**
> The MCP server that decides which of your agent's memories survive.

```
   ○            △            □
pending  →    active   →   promoted
   ↘             ↘
    discarded     superseded
```

OpenSquid is the user-facing MCP layer over [`loop-engine`](https://github.com/MindcraftorAI/loop-engine) — a Rust cognitive-memory substrate with an **anti-self-grading promotion gate** at its core. Your agent proposes lessons; OpenSquid decides which ones graduate.

No self-promotion. No vibes. External evidence only.

---

## What it does

OpenSquid surfaces four verbs to your AI agent via MCP:

| Tool | What it does |
|------|--------------|
| **`remember`** | Capture a candidate lesson. Enters as `○ pending`. |
| **`recall`** | Surface relevant lessons + memories for the current task. |
| **`promote`** | Run the wedge gate. `△ active` → `□ promoted`, or blocked with structured reasons. |
| **`eliminate`** | Discard a lesson (terminal). User-authored lessons immune to engine-initiated elimination — explicit intent required. |

Behind those four verbs sits the full `loop-engine` machinery: causal-narrative generation, vector-embedded memory store, citation-chain-preserving compression, skill + persona + team scoping, lifecycle transitions, and the 4-layer wedge ratchet (gate → compression → skill immunity → lesson decrement).

---

## The wedge

Every promotion through OpenSquid runs an external-evidence check. A lesson cannot graduate to `□ promoted` based on the originating agent's own thumbs-up — it must carry:

- Structured causal narrative (`trigger / failure_mode / correction`)
- Confidence level (observed / inferred / speculative)
- Citations to memories the agent actually consumed (typed `EvidenceRef::Memory`)
- A pass through the time-floor + tampered-age + thumbs-down checks

User authorship is load-bearing. If you (the human) explicitly endorse a lesson, the memories it cites become eviction-immune. If the agent self-endorses, no immunity is conferred. **The agent doesn't decide what it learned — you do, indirectly, via the gate.**

---

## Quick start (Claude Code — local development)

Until OpenSquid is published to npm, point Claude Code at the local build:

```bash
git clone git@github.com:smlee/opensquid.git
cd opensquid
npm install
npm run build
```

Then add to Claude Code via the CLI:

```bash
claude mcp add opensquid -- node /absolute/path/to/opensquid/dist/index.js
```

Or edit `~/.claude.json` (or your Claude Code config file) directly:

```json
{
  "mcpServers": {
    "opensquid": {
      "command": "node",
      "args": ["/absolute/path/to/opensquid/dist/index.js"]
    }
  }
}
```

Restart Claude Code. The four tools (`remember`, `recall`, `promote`, `eliminate`) appear under the `opensquid` server.

## Quick start (Cursor / any MCP host)

```json
{
  "mcpServers": {
    "opensquid": {
      "command": "node",
      "args": ["/absolute/path/to/opensquid/dist/index.js"]
    }
  }
}
```

## Try it

In any MCP-enabled chat, ask the model to:

- *"Remember this: SSH host aliases let you push to different GitHub accounts from the same machine. Evidence: my own debugging session today."* → creates a `○ pending` lesson.
- *"Recall anything about SSH or GitHub auth."* → surfaces matching lessons with similarity scores.
- *"Promote lesson les-xxxxxxxx."* → runs the wedge gate. Probably blocks on time-floor for the first hour; that's the point.
- *"Eliminate lesson les-xxxxxxxx."* → discards (refuses if user-authored without `force=true`).

Storage lives at `~/.opensquid/lessons/{status}/<id>.json`. Inspect with `ls ~/.opensquid/lessons/promoted/` to see what graduated.

Set `OPENSQUID_HOME=/some/path` to relocate storage (handy for testing).

---

## Status

**v0.0.1 — scaffold.** MCP surface live; engine integration in progress as `loop-engine` matures its public crate API. Tool calls currently echo a stub response.

Roadmap:

- v0.1 — engine integration. `remember` / `recall` / `promote` / `eliminate` route through `loop-engine` IPC.
- v0.2 — persona + skill activation tools. Session-scoped manifest assembly.
- v0.3 — feedback hooks. `thumbsUp` / `thumbsDown` route into the wedge inputs.
- v1.0 — SemVer freeze on the tool surface.

---

## Design

The visual identity nods to Korean cultural exports of the 2020s — geometric mask symbols ○ △ □, the hidden-judgment / front-man metaphor for the wedge gate, hot pink + teal accent palette. Built by a Korean founder; the borrowing is from the inside, not the outside.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Project family

- **`loop-engine`** — Rust substrate. The cognitive memory + wedge gate. https://github.com/MindcraftorAI/loop-engine
- **`opensquid`** — this repo. MCP server, user-facing surface.
- **MindCraftor** — the product brand. https://mindcraftor.ai (coming)
