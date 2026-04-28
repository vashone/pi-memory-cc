# pi-memory-cc

Claude Code-style memory extension for [pi-agent](https://github.com/badlogic/pi-mono).

The LLM proactively writes and maintains memory files **during conversation** — no post-session extraction, no extra LLM calls.

## How it works

On every `before_agent_start`, the extension:
1. Injects a full memory instruction set into the system prompt (four-type taxonomy, save/access rules, anti-drift guidance)
2. Loads the current `MEMORY.md` index into context

The LLM then decides what to remember and writes files directly using the Write tool.

## Memory layout

```
~/.pi/agent/memory/<project-slug>/
├── MEMORY.md          ← index (max 200 lines / 25KB)
├── user_role.md       ← one file per memory entry
├── feedback_*.md
├── project_*.md
└── reference_*.md
```

## Memory types

| Type | When to save |
|------|-------------|
| `user` | User's role, preferences, knowledge |
| `feedback` | Corrections and confirmed approaches |
| `project` | Context not derivable from code/git |
| `reference` | Pointers to external systems |

## Install

```bash
pi install git:github.com/bozong/pi-memory-cc
```

Or local:

```bash
pi install ./
```

## Commands

- `/memory` — show current MEMORY.md index
- `/memory dir` — show memory directory path
- `/memory clear` — delete all memory files (with confirmation)

## Inspired by

[Claude Code](https://github.com/anthropics/claude-code)'s auto memory system.
