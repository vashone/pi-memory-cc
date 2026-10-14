# pi-memory-cc

Claude Code-style auto memory extension for [pi](https://github.com/earendil-works/pi).

The LLM proactively writes and maintains memory files **during conversation** — no post-session extraction, no extra LLM calls.

## How it works

On every `before_agent_start` event, the extension:
1. Resolves the memory directory from the canonical git root (worktrees share memory with the main repo)
2. Builds the memory instruction set (four-type taxonomy, save/access rules, anti-drift guidance) with the current `MEMORY.md` index
3. Sets it as the `memory` section of pi's structured system prompt

The LLM then decides what to remember and writes memory files directly. pi diffs prompt sections against what the model has already seen, so turns where `MEMORY.md` hasn't changed add nothing to the request, and a change appends only the updated `memory` section. Requires pi 1.1 or later.

## Memory layout

```
~/.pi/agent/memory/<sanitized-git-root>/
├── MEMORY.md          ← index (max 200 lines / 25KB), auto-loaded each turn
├── user_*.md          ← user role, preferences, background
├── feedback_*.md      ← corrections and confirmed approaches
├── project_*.md       ← project context not derivable from code/git
└── reference_*.md     ← pointers to external systems
```

The directory slug is derived from the canonical git root path: all non-alphanumeric characters replaced with `-`, truncated to 200 characters with a djb2 hash suffix if longer.

## Memory types

| Type | When to save |
|------|-------------|
| `user` | User's role, preferences, knowledge |
| `feedback` | Corrections and confirmed approaches |
| `project` | Context not derivable from code/git (deadlines, decisions, incidents) |
| `reference` | Pointers to external systems (Linear, Grafana, Slack, etc.) |

## Install

Local:

```bash
pi install /path/to/pi-memory-cc
```

From git:

```bash
pi install git:github.com/code-B-rabbit/pi-memory-cc
```

Verify installation:

```bash
pi list
```

When working on this repo, load the working copy for a single run instead of installing it:

```bash
pi -e .
```

## Commands

| Command | Description |
|---------|-------------|
| `/memory` | Show current `MEMORY.md` index |
| `/memory show` | Pick a topic file from an interactive selector |
| `/memory show <file>` | Show a specific topic file (e.g. `user_role.md`) |
| `/memory dir` | Show the memory directory path |
| `/memory clear` | Delete all memory files (with confirmation) |

## Testing

Start pi and tell it something about yourself:

```
I'm a backend engineer, mainly Go and Python
```

The LLM should write a `user_*.md` file and update `MEMORY.md`. Verify with `/memory` or `/memory show`.

Restart pi and ask:

```
Do you remember what I do?
```

The LLM should recall from memory.

## Design alignment with Claude Code

The memory strategy is intentionally aligned with [Claude Code](https://github.com/anthropics/claude-code)'s auto memory implementation:

- **Four-type taxonomy** (`user` / `feedback` / `project` / `reference`) — same types, same save/access rules, same anti-drift guidance
- **MEMORY.md as index** — same 200-line / 25KB dual cap with truncation warning; topic files are unlimited
- **Two-step save protocol** — write topic file first, then update `MEMORY.md` index
- **Git root as project key** — canonical git root resolution including worktree support and security validation, so all worktrees of the same repo share one memory directory
- **Path sanitization** — same algorithm as Claude Code (`/[^a-zA-Z0-9]/g → '-'`, djb2 hash suffix when path exceeds 200 characters)
- **Prompt cache stability** — memory lives in its own system prompt section, so a memory write never rewrites the rest of the prompt

The main structural difference is that Claude Code splits the system prompt into a static block (cached globally across sessions) and a dynamic block (memory + env info, not cached). pi instead builds the system prompt from named sections and appends only changed sections to the transcript; memory is one of those sections.
