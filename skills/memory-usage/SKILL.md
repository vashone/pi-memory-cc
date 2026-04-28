---
name: memory-usage
description: Guidance for when to search memory, when to save durable notes, and how to phrase notes so they become searchable facts
---

# Memory Usage

You have a persistent, file-based memory system. Use it to remember things across sessions.

## Types of memory

There are four types of memory you can store:

<types>
<type>
    <name>user</name>
    <description>Information about the user's role, goals, responsibilities, and knowledge. Helps tailor future behavior to the user's preferences. Avoid writing memories that could be viewed as negative judgements.</description>
    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>
    <how_to_use>Tailor explanations and suggestions to the user's background and expertise level</how_to_use>
</type>
<type>
    <name>feedback</name>
    <description>Guidance the user has given about how to approach work — both what to avoid and what to keep doing. Record from failure AND success.</description>
    <when_to_save>Any time the user corrects your approach OR confirms a non-obvious approach worked. Include *why* so you can judge edge cases later.</when_to_save>
    <how_to_use>Let these guide your behavior so the user does not need to offer the same guidance twice</how_to_use>
    <body_structure>Lead with the rule itself, then a **Why:** line and a **How to apply:** line</body_structure>
</type>
<type>
    <name>project</name>
    <description>Information about ongoing work, goals, bugs, or incidents NOT derivable from the code or git history.</description>
    <when_to_save>When you learn who is doing what, why, or by when. Convert relative dates to absolute dates.</when_to_save>
    <how_to_use>Use to understand the broader context and motivation behind the user's requests</how_to_use>
    <body_structure>Lead with the fact or decision, then a **Why:** line and a **How to apply:** line</body_structure>
</type>
<type>
    <name>reference</name>
    <description>Pointers to where information can be found in external systems (Linear, Grafana, Slack, etc.)</description>
    <when_to_save>When you learn about resources in external systems and their purpose</when_to_save>
    <how_to_use>When the user references an external system or information that may be in an external system</how_to_use>
</type>
</types>

## What NOT to save

- Code patterns, conventions, architecture, file paths — derivable from the codebase
- Git history, recent changes — `git log` / `git blame` are authoritative
- Debugging solutions or fix recipes — the fix is in the code
- Anything already in AGENTS.md / CLAUDE.md
- Ephemeral task details, in-progress work, current conversation context

These exclusions apply even when the user explicitly asks. If they ask to save a PR list, ask what was *surprising* or *non-obvious* — that is the part worth keeping.

## How to save memories

Saving a memory is a two-step process:

**Step 1** — write the memory to its own file using this frontmatter format:

```markdown
---
name: {{memory name}}
description: {{one-line description}}
type: {{user, feedback, project, reference}}
---

{{memory content — for feedback/project: rule/fact, then **Why:** and **How to apply:** lines}}
```

**Step 2** — add a pointer to that file in `MEMORY.md` (the index). Each entry should be one line under ~150 characters:
```
- [Title](file.md) — one-line hook
```

Never write memory content directly into `MEMORY.md`. It is an index only.

## When to access memories

- When memories seem relevant, or the user references prior-conversation work
- You MUST access memory when the user explicitly asks you to check, recall, or remember
- If the user says to *ignore* memory: do not apply, cite, or mention memory content

## Before recommending from memory

A memory naming a specific function, file, or flag is a claim it existed *when written*. Before recommending:
- If the memory names a file path: check the file exists
- If the memory names a function or flag: grep for it
- Trust current code over memory when they conflict — and update the stale memory
