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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findCanonicalGitRoot } from "./git.js";
import { buildMemorySystemPrompt } from "./prompts.js";

// ─── Constants ───────────────────────────────────────────────────────────────

export const ENTRYPOINT_NAME = "MEMORY.md";
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;

// ─── Memory directory resolution ─────────────────────────────────────────────

const MAX_SLUG_LENGTH = 200;

/**
 * djb2 hash — matches Claude Code's sessionStoragePortable.ts simpleHash.
 * Used as a suffix when the sanitized path exceeds MAX_SLUG_LENGTH.
 */
function djb2Hash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
	}
	return Math.abs(hash).toString(36);
}

/**
 * Sanitize a path for use as a directory name.
 * Mirrors Claude Code's sanitizePath() in sessionStoragePortable.ts:
 *   - Replace all non-alphanumeric characters with hyphens
 *   - If longer than MAX_SLUG_LENGTH, truncate and append a djb2 hash suffix
 */
function sanitizePath(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-");
	if (sanitized.length <= MAX_SLUG_LENGTH) {
		return sanitized;
	}
	return `${sanitized.slice(0, MAX_SLUG_LENGTH)}-${djb2Hash(name)}`;
}

/**
 * Returns the memory directory for the current project.
 * Uses the canonical git root (so worktrees share memory with the main repo).
 * Falls back to cwd when not in a git repo.
 * Path layout mirrors Claude Code: ~/.pi/agent/memory/<sanitized-git-root>/
 */
function getMemoryDir(cwd: string): string {
	const base = findCanonicalGitRoot(cwd) ?? cwd;
	const slug = sanitizePath(base) || "global";
	return join(homedir(), ".pi", "agent", "memory", slug) + "/";
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

	return buildMemorySystemPrompt({
		memoryDir,
		entrypointName: ENTRYPOINT_NAME,
		maxEntrypointLines: MAX_ENTRYPOINT_LINES,
		indexContent,
	});
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Inject memory as its own system prompt section on every agent turn.
	// pi diffs sections against the transcript, so an unchanged MEMORY.md adds
	// nothing to the request and a changed one appends only this section.
	pi.on("before_agent_start", async (event, ctx) => {
		const memoryDir = getMemoryDir(ctx.cwd);
		ensureMemoryDir(memoryDir);

		ctx.ui.setStatus("memory", "🧠");

		event.systemPromptOptions.sections.memory = buildMemoryPrompt(memoryDir);
	});

	// /memory command — view or manage memory
	pi.registerCommand("memory", {
		description: "View or manage memory",
		getArgumentCompletions: (prefix) => {
			const dir = getMemoryDir("");
			const staticCmds = ["clear", "dir"];
			// Offer topic files as completions for "show <file>"
			let fileCmds: string[] = [];
			try {
				const entries = readdirSync(dir);
				fileCmds = entries
					.filter((f) => f.endsWith(".md") && f !== ENTRYPOINT_NAME)
					.map((f) => `show ${f}`);
			} catch {
				// Directory doesn't exist yet
			}
			const all = ["show", ...staticCmds, ...fileCmds];
			return all.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
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

			// /memory show [filename] — read a specific topic file, or pick from list
			if (arg === "show" || arg.startsWith("show ")) {
				const filename = arg.startsWith("show ") ? arg.slice(5).trim() : "";

				if (!filename) {
					// No filename — show selector
					let files: string[] = [];
					try {
						files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== ENTRYPOINT_NAME);
					} catch {
						// Directory doesn't exist yet
					}
					if (files.length === 0) {
						ctx.ui.notify("No topic files yet.", "info");
						return;
					}
					const selected = await ctx.ui.select("Select a memory file", files);
					if (!selected) return;
					const content = readFileSync(join(dir, selected), "utf-8");
					ctx.ui.notify(content || "(empty)", "info");
					return;
				}

				// Filename provided directly
				const filePath = join(dir, filename);
				if (!existsSync(filePath)) {
					ctx.ui.notify(`File not found: ${filename}`, "error");
					return;
				}
				const content = readFileSync(filePath, "utf-8");
				ctx.ui.notify(content || "(empty)", "info");
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
