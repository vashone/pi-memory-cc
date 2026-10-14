/**
 * Tests for the extension's system prompt injection, memory directory, and
 * /memory command.
 *
 * Drives the extension through a minimal fake pi API (the system boundary)
 * against a real temp HOME, so memory files live on a real filesystem.
 */

import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	NormalizedBuildSystemPromptOptions,
	RegisteredCommand,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import memoryExtension, { sanitizePath } from "../extensions/memory.js";
import { addWorktree, initRepo } from "./git-fixtures.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmp: string;
let project: string;
let originalHome: string | undefined;

beforeEach(() => {
	// Physical path, like the paths git records (tmpdir() is a symlink on macOS)
	tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-memory-ext-test-")));
	project = join(tmp, "project");
	mkdirSync(project);
	originalHome = process.env.HOME;
	process.env.HOME = join(tmp, "home");
});

afterEach(() => {
	process.env.HOME = originalHome;
	rmSync(tmp, { recursive: true, force: true });
});

type BeforeAgentStartHandler = (
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | void>;

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;

type MemoryCommand = Pick<RegisteredCommand, "getArgumentCompletions" | "handler">;

/** Load the extension into a fake pi that records its event handlers and the /memory command. */
function loadExtension() {
	let onBeforeAgentStart: BeforeAgentStartHandler | undefined;
	let onSessionStart: SessionStartHandler | undefined;
	let memoryCommand: MemoryCommand | undefined;
	const pi = {
		on: (event: string, handler: BeforeAgentStartHandler & SessionStartHandler) => {
			if (event === "before_agent_start") onBeforeAgentStart = handler;
			if (event === "session_start") onSessionStart = handler;
		},
		registerCommand: (name: string, command: MemoryCommand) => {
			if (name === "memory") memoryCommand = command;
		},
	} as unknown as ExtensionAPI;
	memoryExtension(pi);

	/** Start a session in `cwd` the way pi does. */
	async function startSession(cwd = project) {
		const ctx = { cwd, ui: { setStatus: () => {} } } as unknown as ExtensionContext;
		await onSessionStart!({ type: "session_start", reason: "startup" }, ctx);
	}

	/** The /memory argument completions pi offers for `prefix`. */
	async function completeMemoryCommand(prefix: string): Promise<string[]> {
		const items = await memoryCommand!.getArgumentCompletions!(prefix);
		return (items ?? []).map((item) => item.value);
	}

	/** Run `/memory <args>`, confirming any prompt, and return the notifications it shows. */
	async function runMemoryCommand(args: string) {
		const notifications: { message: string; type?: string }[] = [];
		const ui = {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			confirm: async () => true,
		};
		await memoryCommand!.handler(args, { cwd: project, ui } as unknown as ExtensionCommandContext);
		return notifications;
	}

	/**
	 * Run one before_agent_start the way pi does, returning the handler result and the prompt sections.
	 * Prompt options default to pi's: the project cwd and the default tools, none hidden.
	 */
	async function startTurn(options: Partial<NormalizedBuildSystemPromptOptions> = {}) {
		const systemPromptOptions = {
			cwd: project,
			sections: {},
			selectedTools: ["read", "bash", "edit", "write"],
			hiddenTools: [],
			...options,
		};
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hi",
			systemPrompt: "",
			systemPromptOptions,
		} as unknown as BeforeAgentStartEvent;
		const ctx = { cwd: systemPromptOptions.cwd } as unknown as ExtensionContext;
		const result = await onBeforeAgentStart!(event, ctx);
		return { result, sections: event.systemPromptOptions.sections };
	}

	return { startSession, startTurn, completeMemoryCommand, runMemoryCommand };
}

/** ~/.pi/agent/memory/ under the temp HOME, which holds one directory per project. */
function memoryRoot(): string {
	return join(process.env.HOME!, ".pi", "agent", "memory");
}

/** The project's memory directory: the single directory under ~/.pi/agent/memory/ after a turn. */
function memoryDir(): string {
	const [slug, ...rest] = readdirSync(memoryRoot());
	expect(rest).toEqual([]);
	return join(memoryRoot(), slug);
}

/** Run a turn from each cwd, then list the memory directories those turns created. */
async function memoryDirsAfterTurnsIn(...cwds: string[]): Promise<string[]> {
	const { startTurn } = loadExtension();
	for (const cwd of cwds) await startTurn({ cwd });
	return readdirSync(memoryRoot());
}

/** Create a symlink to `target` in a separate links/ directory, so relative paths through it break. */
function symlinkTo(target: string): string {
	const link = join(tmp, "links", basename(target));
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(target, link);
	return link;
}

// ─── before_agent_start ──────────────────────────────────────────────────────

describe("memory section injection", () => {
	it("injects an empty-index notice as the memory section without forcing the system prompt", async () => {
		const { startTurn } = loadExtension();
		const { result, sections } = await startTurn();

		expect(result?.systemPrompt).toBeUndefined();
		expect(sections.memory).toContain("Your MEMORY.md is currently empty.");
	});

	it("injects the current MEMORY.md index on every turn", async () => {
		const { startTurn } = loadExtension();
		await startTurn();
		const index = join(memoryDir(), "MEMORY.md");

		writeFileSync(index, "- [Role](user_role.md) — backend engineer, Go and Python\n");
		const first = await startTurn();
		expect(first.sections.memory).toContain("- [Role](user_role.md) — backend engineer, Go and Python");
		expect(first.sections.memory).not.toContain("currently empty");

		writeFileSync(index, "- [Testing](feedback_testing.md) — no mocked databases\n");
		const second = await startTurn();
		expect(second.sections.memory).toContain("- [Testing](feedback_testing.md) — no mocked databases");
		expect(second.sections.memory).not.toContain("backend engineer");
	});

	it("keeps sections set by earlier extensions", async () => {
		const { startTurn } = loadExtension();
		const { sections } = await startTurn({ sections: { todos: "- ship #1" } });

		expect(sections.todos).toBe("- ship #1");
		expect(sections.memory).toBeDefined();
	});

	it("tells the model to save with the write tool when it is active", async () => {
		const { startTurn } = loadExtension();
		const { sections } = await startTurn();

		expect(sections.memory).toContain("with the write tool");
	});

	it.each([
		["deactivated", { selectedTools: ["read", "bash", "edit"] }],
		["hidden from the model", { hiddenTools: ["write"] }],
	])("does not name the write tool when it is %s", async (_state, options) => {
		const { startTurn } = loadExtension();
		const { sections } = await startTurn(options);

		expect(sections.memory).not.toContain("write tool");
	});
});

// ─── MEMORY.md index caps ────────────────────────────────────────────────────

const TRUNCATION_WARNING = "> WARNING: MEMORY.md was truncated.";

/** `count` distinct index lines of `bytes` UTF-8 bytes each: a 3-digit number, a space, then 3-byte CJK characters. */
function cjkIndexLines(count: number, bytes: number): string[] {
	return Array.from({ length: count }, (_, i) => `${String(i).padStart(3, "0")} ${"記".repeat((bytes - 4) / 3)}`);
}

/** Write `lines` as the project's MEMORY.md, then return the memory section of the next turn. */
async function memorySectionWithIndex(lines: string[]): Promise<string> {
	const { startTurn } = loadExtension();
	await startTurn();
	writeFileSync(join(memoryDir(), "MEMORY.md"), `${lines.join("\n")}\n`);
	const { sections } = await startTurn();
	return sections.memory;
}

describe("MEMORY.md index caps", () => {
	it("cuts a CJK index over 25,000 bytes at the last line boundary under the cap", async () => {
		// 150 lines of 250 bytes: 37,649 bytes, but only 13,049 UTF-16 code units.
		// 99 lines and their newlines take 24,848 bytes; 100 would take 25,099.
		const lines = cjkIndexLines(150, 250);
		const memory = await memorySectionWithIndex(lines);

		expect(memory).toContain(`${lines.slice(0, 99).join("\n")}\n\n${TRUNCATION_WARNING}`);
		expect(memory).not.toContain(lines[99]);
	});

	it("cuts an index over 200 lines to 200 lines", async () => {
		const lines = cjkIndexLines(250, 40);
		const memory = await memorySectionWithIndex(lines);

		expect(memory).toContain(`${lines.slice(0, 200).join("\n")}\n\n${TRUNCATION_WARNING}`);
		expect(memory).not.toContain(lines[200]);
	});

	it("passes an index within both caps through unchanged", async () => {
		// 200 lines of 124 bytes: 24,999 bytes with their newlines.
		const lines = cjkIndexLines(200, 124);
		const memory = await memorySectionWithIndex(lines);

		expect(memory).toContain(lines.join("\n"));
		expect(memory).not.toContain(TRUNCATION_WARNING);
	});
});

// ─── /memory command ─────────────────────────────────────────────────────────

describe("/memory command", () => {
	it("completes the topic files of the session's memory directory, not the process cwd's", async () => {
		expect(process.cwd()).not.toBe(project);
		const { startSession, startTurn, completeMemoryCommand } = loadExtension();
		await startSession(project);
		await startTurn();
		for (const file of ["MEMORY.md", "user_role.md", "feedback_testing.md"]) {
			writeFileSync(join(memoryDir(), file), "");
		}

		expect((await completeMemoryCommand("show ")).sort()).toEqual(["show feedback_testing.md", "show user_role.md"]);
	});

	it.each([
		["a relative path", () => "../outside.md"],
		["an absolute path", () => join(memoryRoot(), "outside.md")],
	])("show reports an error for %s outside the memory directory and reads nothing", async (_kind, name) => {
		const { startSession, startTurn, runMemoryCommand } = loadExtension();
		await startSession();
		await startTurn();
		writeFileSync(join(memoryRoot(), "outside.md"), "another project's memory");

		expect(await runMemoryCommand(`show ${name()}`)).toEqual([
			{ message: expect.not.stringContaining("another project's memory"), type: "error" },
		]);
	});

	it("clear reports there is nothing to clear when there is no memory directory", async () => {
		const { startSession, runMemoryCommand } = loadExtension();
		await startSession();

		expect(await runMemoryCommand("clear")).toEqual([{ message: "Nothing to clear.", type: "info" }]);
	});
});

// ─── Memory directory ────────────────────────────────────────────────────────

describe("memory directory", () => {
	it("is the same for a symlink to the repo as for the repo", async () => {
		const repo = initRepo(join(tmp, "repo"));
		expect(await memoryDirsAfterTurnsIn(repo, symlinkTo(repo))).toHaveLength(1);
	});

	it("is the main repo's for a worktree and for a symlink to the worktree", async () => {
		const mainRepo = initRepo(join(tmp, "main"));
		const worktree = addWorktree(mainRepo, join(tmp, "worktree"), "relative");
		expect(await memoryDirsAfterTurnsIn(mainRepo, worktree, symlinkTo(worktree))).toHaveLength(1);
	});

	it("is the same for a symlink to a directory outside any git repo as for the directory", async () => {
		expect(await memoryDirsAfterTurnsIn(project, symlinkTo(project))).toHaveLength(1);
	});
});

// Existing memory directories are found by these names: changing them orphans users' memory.
describe("memory directory name", () => {
	it("replaces every non-alphanumeric character of the path with a hyphen", () => {
		expect(sanitizePath("/Users/alice/code/my_app.v2")).toBe("-Users-alice-code-my-app-v2");
	});

	it("truncates a path over 200 characters and appends a hash of the full path", () => {
		const path = `/home/alice/projects/${"deeply-nested-directory/".repeat(9)}app`;
		expect(sanitizePath(path)).toBe(
			"-home-alice-projects-deeply-nested-directory-deeply-nested-directory-deeply-nested-directory-deeply-nested-directory-deeply-nested-directory-deeply-nested-directory-deeply-nested-directory-deeply-nest-gnfhew",
		);
	});
});
