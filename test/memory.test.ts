/**
 * Tests for the extension's system prompt injection.
 *
 * Drives the extension through a minimal fake pi API (the system boundary)
 * against a real temp HOME, so memory files live on a real filesystem.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import memoryExtension from "../extensions/memory.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmp: string;
let project: string;
let originalHome: string | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-memory-ext-test-"));
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
	return async function startTurn(sections: Record<string, string> = {}) {
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hi",
			systemPrompt: "",
			systemPromptOptions: { cwd: project, sections },
		} as unknown as BeforeAgentStartEvent;
		const ctx = { cwd: project, ui: { setStatus: () => {} } } as unknown as ExtensionContext;
		const result = await onBeforeAgentStart!(event, ctx);
		return { result, sections: event.systemPromptOptions.sections };
	};
}

/** The project's memory directory: the single directory under ~/.pi/agent/memory/ after a turn. */
function memoryDir(): string {
	const root = join(process.env.HOME!, ".pi", "agent", "memory");
	const [slug, ...rest] = readdirSync(root);
	expect(rest).toEqual([]);
	return join(root, slug);
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
