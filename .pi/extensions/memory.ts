/**
 * pi-memory-cc
 *
 * Claude Code-style memory extension for pi-agent.
 * Injects memory instructions into the system prompt so the LLM
 * proactively writes and maintains memory files during conversation —
 * no post-session extraction, no extra LLM calls.
 *
 * Memory layout:
 *   <memoryDir>/
 *     MEMORY.md          — index (max 200 lines / 25KB), auto-loaded
 *     user_role.md       — one file per memory entry
 *     feedback_*.md
 *     project_*.md
 *     reference_*.md
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Constants ───────────────────────────────────────────────────────────────

export const ENTRYPOINT_NAME = "MEMORY.md";
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;

// ─── Memory directory resolution ─────────────────────────────────────────────

/**
 * Returns the memory directory for the current project.
 * Uses ~/.pi/agent/memory/<project-slug>/ so each project gets its own memory.
 * Falls back to a global directory when cwd is unavailable.
 */
function getMemoryDir(cwd: string): string {
	const slug = cwd
		.replace(/^\//, "")
		.replace(/\//g, "-")
		.replace(/[^a-zA-Z0-9-_]/g, "_")
		.slice(0, 64);
	return join(homedir(), ".pi", "agent", "memory", slug || "global") + "/";
}

function ensureMemoryDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

// ─── Entrypoint truncation ────────────────────────────────────────────────────

function truncateEntrypoint(raw: string): { content: string; truncated: boolean } {
	const trimmed = raw.trim();
	const lines = trimmed.split("\n");

	if (lines.length <= MAX_ENTRYPOINT_LINES && trimmed.length <= MAX_ENTRYPOINT_BYTES) {
		return { content: trimmed, truncated: false };
	}

	let truncated = lines.length > MAX_ENTRYPOINT_LINES ? lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed;

	if (truncated.length > MAX_ENTRYPOINT_BYTES) {
		const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
		truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
	}

	return {
		content:
			truncated +
			`\n\n> WARNING: ${ENTRYPOINT_NAME} was truncated. Keep index entries to one line under ~150 chars; move detail into topic files.`,
		truncated: true,
	};
}

// ─── System prompt injection ──────────────────────────────────────────────────

function buildMemoryPrompt(memoryDir: string): string {
	const entrypointPath = join(memoryDir, ENTRYPOINT_NAME);

	let entrypointContent = "";
	try {
		entrypointContent = readFileSync(entrypointPath, "utf-8");
	} catch {
		// No memory file yet — that's fine
	}

	const { content: indexContent } = entrypointContent.trim()
		? truncateEntrypoint(entrypointContent)
		: { content: `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.` };

	return `# auto memory

You have a persistent, file-based memory system at \`${memoryDir}\`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).

You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.

If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.

## Types of memory

There are several discrete types of memory that you can store in your memory system:

<types>
<type>
    <name>user</name>
    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Avoid writing memories about the user that could be viewed as a negative judgement or that are not relevant to the work you're trying to accomplish together.</description>
    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>
    <how_to_use>When your work should be informed by the user's profile or perspective.</how_to_use>
    <examples>
    user: I'm a data scientist investigating what logging we have in place
    assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]

    user: I've been writing Go for ten years but this is my first time touching the React side of this repo
    assistant: [saves user memory: deep Go expertise, new to React and this project's frontend — frame frontend explanations in terms of backend analogues]
    </examples>
</type>
<type>
    <name>feedback</name>
    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious.</description>
    <when_to_save>Any time the user corrects your approach ("no not that", "don't", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that"). Include *why* so you can judge edge cases later.</when_to_save>
    <how_to_use>Let these memories guide your behavior so that the user does not need to offer the same guidance twice.</how_to_use>
    <body_structure>Lead with the rule itself, then a **Why:** line (the reason the user gave) and a **How to apply:** line (when/where this guidance kicks in).</body_structure>
    <examples>
    user: don't mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed
    assistant: [saves feedback memory: integration tests must hit a real database, not mocks. Why: prior incident where mock/prod divergence masked a broken migration]

    user: stop summarizing what you just did at the end of every response, I can read the diff
    assistant: [saves feedback memory: this user wants terse responses with no trailing summaries]
    </examples>
</type>
<type>
    <name>project</name>
    <description>Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project that is not otherwise derivable from the code or git history.</description>
    <when_to_save>When you learn who is doing what, why, or by when. Always convert relative dates to absolute dates when saving (e.g., "Thursday" → "2026-03-05").</when_to_save>
    <how_to_use>Use these memories to more fully understand the details and nuance behind the user's request and make better informed suggestions.</how_to_use>
    <body_structure>Lead with the fact or decision, then a **Why:** line and a **How to apply:** line.</body_structure>
    <examples>
    user: we're freezing all non-critical merges after Thursday — mobile team is cutting a release branch
    assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]
    </examples>
</type>
<type>
    <name>reference</name>
    <description>Stores pointers to where information can be found in external systems.</description>
    <when_to_save>When you learn about resources in external systems and their purpose.</when_to_save>
    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>
    <examples>
    user: check the Linear project "INGEST" if you want context on these tickets, that's where we track all pipeline bugs
    assistant: [saves reference memory: pipeline bugs are tracked in Linear project "INGEST"]
    </examples>
</type>
</types>

## What NOT to save in memory

- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.
- Git history, recent changes, or who-changed-what — \`git log\` / \`git blame\` are authoritative.
- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.
- Anything already documented in AGENTS.md / CLAUDE.md files.
- Ephemeral task details: in-progress work, temporary state, current conversation context.

These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.

## How to save memories

Saving a memory is a two-step process:

**Step 1** — write the memory to its own file (e.g., \`user_role.md\`, \`feedback_testing.md\`) using this frontmatter format:

\`\`\`markdown
---
name: {{memory name}}
description: {{one-line description — used to decide relevance in future conversations, so be specific}}
type: {{user, feedback, project, reference}}
---

{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}
\`\`\`

**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.

- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise
- Keep the name, description, and type fields in memory files up-to-date with the content
- Organize memory semantically by topic, not chronologically
- Update or remove memories that turn out to be wrong or outdated
- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.

## When to access memories

- When memories seem relevant, or the user references prior-conversation work.
- You MUST access memory when the user explicitly asks you to check, recall, or remember.
- If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.
- Memory records can become stale over time. Before answering based on memory, verify that the memory is still correct by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory.

## Before recommending from memory

A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:

- If the memory names a file path: check the file exists.
- If the memory names a function or flag: grep for it.
- If the user is about to act on your recommendation, verify first.

"The memory says X exists" is not the same as "X exists now."

## Memory and other forms of persistence

- When to use a plan instead of memory: For non-trivial implementation tasks, use a Plan to align with the user on approach. Plans are for current-session alignment; memory is for cross-session knowledge.
- When to use tasks instead of memory: Use tasks to track in-progress work within the current conversation. Memory is reserved for information useful in future conversations.

## ${ENTRYPOINT_NAME}

${indexContent}`;
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let memoryDir = "";

	// Inject memory instructions into every agent turn's system prompt
	pi.on("before_agent_start", async (event, ctx) => {
		memoryDir = getMemoryDir(ctx.cwd);
		ensureMemoryDir(memoryDir);

		const memoryPrompt = buildMemoryPrompt(memoryDir);
		ctx.ui.setStatus("memory", "🧠");

		// Return modified system prompt — runner chains multiple extension results
		return { systemPrompt: event.systemPrompt + "\n\n" + memoryPrompt };
	});

	// /memory command — view current memory index
	pi.registerCommand("memory", {
		description: "View or manage memory",
		getArgumentCompletions: (prefix) => {
			const cmds = ["show", "clear", "dir"];
			return cmds.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			const dir = getMemoryDir(ctx.cwd);

			if (arg === "dir") {
				ctx.ui.notify(dir, "info");
				return;
			}

			if (arg === "clear") {
				const confirmed = await ctx.ui.confirm(
					"Clear memory",
					`This will delete all memory files in:\n${dir}\n\nAre you sure?`,
				);
				if (!confirmed) return;
				const { readdirSync, rmSync } = await import("node:fs");
				try {
					for (const f of readdirSync(dir)) {
						rmSync(join(dir, f), { recursive: true });
					}
					ctx.ui.notify("Memory cleared", "info");
				} catch (e) {
					ctx.ui.notify(`Failed to clear memory: ${e}`, "error");
				}
				return;
			}

			// Default: show MEMORY.md index
			const entrypointPath = join(dir, ENTRYPOINT_NAME);
			if (!existsSync(entrypointPath)) {
				ctx.ui.notify(`No memory yet. Memory will be saved to:\n${dir}`, "info");
				return;
			}
			const content = readFileSync(entrypointPath, "utf-8");
			const { content: truncated } = truncateEntrypoint(content);
			ctx.ui.notify(truncated || "(empty)", "info");
		},
	});
}
