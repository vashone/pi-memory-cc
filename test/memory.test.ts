/**
 * Tests for the extension's system prompt injection and memory directory.
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
	ExtensionContext,
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

/** Load the extension into a fake pi that records the before_agent_start handler. */
function loadExtension() {
	let onBeforeAgentStart: BeforeAgentStartHandler | undefined;
	const pi = {
		on: (event: string, handler: BeforeAgentStartHandler) => {
			if (event === "before_agent_start") onBeforeAgentStart = handler;
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	memoryExtension(pi);

	/** Run one before_agent_start the way pi does, returning the handler result and the prompt sections. */
	return async function startTurn(sections: Record<string, string> = {}, cwd = project) {
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hi",
			systemPrompt: "",
			systemPromptOptions: { cwd, sections },
		} as unknown as BeforeAgentStartEvent;
		const ctx = { cwd, ui: { setStatus: () => {} } } as unknown as ExtensionContext;
		const result = await onBeforeAgentStart!(event, ctx);
		return { result, sections: event.systemPromptOptions.sections };
	};
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
	const startTurn = loadExtension();
	for (const cwd of cwds) await startTurn({}, cwd);
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
		const startTurn = loadExtension();
		const { result, sections } = await startTurn();

		expect(result?.systemPrompt).toBeUndefined();
		expect(sections.memory).toContain("Your MEMORY.md is currently empty.");
	});

	it("injects the current MEMORY.md index on every turn", async () => {
		const startTurn = loadExtension();
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
		const startTurn = loadExtension();
		const { sections } = await startTurn({ todos: "- ship #1" });

		expect(sections.todos).toBe("- ship #1");
		expect(sections.memory).toBeDefined();
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
