/**
 * Tests for findGitRoot and findCanonicalGitRoot.
 *
 * Uses a temp directory with real git checkouts (or fixtures that copy them,
 * see git-fixtures.ts) plus hand-built layouts:
 *   - regular repo (.git is a directory)
 *   - worktrees with absolute and relative paths (.git is a file pointing to main repo)
 *   - security: a checkout whose worktree backlink points elsewhere
 *   - submodule (.git is a file but no commondir)
 *   - non-git directory
 *   - subdirectory inside a repo
 *   - security: malicious commondir pointer
 */

import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCanonicalGitRoot, findGitRoot } from "../extensions/git.js";
import { addWorktree, initRepo } from "./git-fixtures.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
	// Physical path, like the paths git records (tmpdir() is a symlink on macOS)
	tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-memory-git-test-")));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

// ─── findGitRoot ─────────────────────────────────────────────────────────────

describe("findGitRoot", () => {
	it("returns the repo root when .git is a directory", () => {
		const repo = initRepo(join(tmp, "repo"));
		expect(findGitRoot(repo)).toBe(repo);
	});

	it("finds root from a subdirectory", () => {
		const repo = initRepo(join(tmp, "repo"));
		const sub = join(repo, "src", "utils");
		mkdirSync(sub, { recursive: true });
		expect(findGitRoot(sub)).toBe(repo);
	});

	it("returns null when no .git exists", () => {
		const dir = join(tmp, "no-git");
		mkdirSync(dir);
		expect(findGitRoot(dir)).toBeNull();
	});

	it("returns the worktree dir when .git is a file", () => {
		const mainRepo = initRepo(join(tmp, "main"));
		const worktree = addWorktree(mainRepo, join(tmp, "worktree"), "absolute");
		// findGitRoot stops at the .git file — canonical resolution is findCanonicalGitRoot's job
		expect(findGitRoot(worktree)).toBe(worktree);
	});
});

// ─── findCanonicalGitRoot ─────────────────────────────────────────────────────

describe("findCanonicalGitRoot", () => {
	it("returns the repo root for a regular repo", () => {
		const repo = initRepo(join(tmp, "repo"));
		expect(findCanonicalGitRoot(repo)).toBe(repo);
	});

	it("resolves the main working tree and its absolute- and relative-path worktrees to the main repo root", () => {
		const mainRepo = initRepo(join(tmp, "main"));
		const absolute = addWorktree(mainRepo, join(tmp, "wt-abs"), "absolute");
		const relative = addWorktree(mainRepo, join(tmp, "wt-rel"), "relative");
		expect([mainRepo, absolute, relative].map(findCanonicalGitRoot)).toEqual([mainRepo, mainRepo, mainRepo]);
	});

	it.each(["absolute", "relative"] as const)(
		"keeps its own root when the worktree backlink points to another checkout (%s paths)",
		(paths) => {
			const mainRepo = initRepo(join(tmp, "main"));
			const worktree = addWorktree(mainRepo, join(tmp, "worktree"), paths);
			// A sibling claims the worktree's gitdir; that gitdir's backlink still names the worktree
			const impostor = join(tmp, "impostor");
			mkdirSync(impostor);
			copyFileSync(join(worktree, ".git"), join(impostor, ".git"));
			expect(findCanonicalGitRoot(impostor)).toBe(impostor);
		},
	);

	it("returns null when not in a git repo", () => {
		const dir = join(tmp, "no-git");
		mkdirSync(dir);
		expect(findCanonicalGitRoot(dir)).toBeNull();
	});

	it("falls through to gitRoot for a submodule (no commondir)", () => {
		// Submodule: .git is a file but worktreeGitDir has no commondir
		const submodule = join(tmp, "submodule");
		mkdirSync(submodule);
		const fakeGitDir = join(tmp, "fake-gitdir");
		mkdirSync(fakeGitDir);
		writeFileSync(join(submodule, ".git"), `gitdir: ${fakeGitDir}\n`);
		// No commondir file → readFileSync throws → falls through to gitRoot
		expect(findCanonicalGitRoot(submodule)).toBe(submodule);
	});

	it("security: rejects malicious commondir pointing outside worktrees/", () => {
		// Attacker crafts a .git file + commondir pointing to a victim repo
		initRepo(join(tmp, "main"));
		const victim = initRepo(join(tmp, "victim"));
		const malicious = join(tmp, "malicious");
		mkdirSync(malicious);

		// .git file points to a fake gitdir
		const fakeGitDir = join(tmp, "fake-gitdir");
		mkdirSync(fakeGitDir);
		writeFileSync(join(malicious, ".git"), `gitdir: ${fakeGitDir}\n`);
		// commondir points to victim's .git — but fakeGitDir is NOT under victim/.git/worktrees/
		writeFileSync(join(fakeGitDir, "commondir"), join(victim, ".git") + "\n");

		// Should fall back to malicious dir (gitRoot), not victim
		expect(findCanonicalGitRoot(malicious)).toBe(malicious);
	});
});
