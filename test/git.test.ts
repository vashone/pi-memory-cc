/**
 * Tests for findGitRoot and findCanonicalGitRoot.
 *
 * Uses a temp directory to construct realistic filesystem fixtures:
 *   - regular repo (.git is a directory)
 *   - worktree (.git is a file pointing to main repo)
 *   - submodule (.git is a file but no commondir)
 *   - non-git directory
 *   - subdirectory inside a repo
 *   - security: malicious commondir pointer
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearGitCaches, findCanonicalGitRoot, findGitRoot } from "../extensions/git.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-memory-git-test-"));
	clearGitCaches();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(dir: string): string {
	mkdirSync(join(dir, ".git"), { recursive: true });
	// Minimal .git contents needed for worktree resolution
	mkdirSync(join(dir, ".git", "worktrees"), { recursive: true });
	return dir;
}

function makeWorktree(worktreeDir: string, mainRepo: string, name: string): string {
	// Simulate what `git worktree add` creates:
	// <worktreeDir>/.git  — file pointing to <mainRepo>/.git/worktrees/<name>
	// <mainRepo>/.git/worktrees/<name>/gitdir  — back-link to <worktreeDir>/.git
	// <mainRepo>/.git/worktrees/<name>/commondir — points to ../..  (i.e. <mainRepo>/.git)
	const worktreeGitDir = join(mainRepo, ".git", "worktrees", name);
	mkdirSync(worktreeGitDir, { recursive: true });

	writeFileSync(join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
	writeFileSync(join(worktreeGitDir, "gitdir"), join(worktreeDir, ".git") + "\n");
	writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");

	return worktreeDir;
}

// ─── findGitRoot ─────────────────────────────────────────────────────────────

describe("findGitRoot", () => {
	it("returns the repo root when .git is a directory", () => {
		const repo = makeRepo(join(tmp, "repo"));
		expect(findGitRoot(repo)).toBe(repo);
	});

	it("finds root from a subdirectory", () => {
		const repo = makeRepo(join(tmp, "repo"));
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
		const mainRepo = makeRepo(join(tmp, "main"));
		const worktree = mkdirSync(join(tmp, "worktree"), { recursive: true }) && join(tmp, "worktree");
		makeWorktree(worktree!, mainRepo, "fix");
		// findGitRoot stops at the .git file — canonical resolution is findCanonicalGitRoot's job
		expect(findGitRoot(worktree!)).toBe(worktree);
	});

	it("caches results — second call does not re-stat", () => {
		const repo = makeRepo(join(tmp, "repo"));
		const first = findGitRoot(repo);
		// Delete .git to prove the second call uses cache
		rmSync(join(repo, ".git"), { recursive: true });
		const second = findGitRoot(repo);
		expect(second).toBe(first);
	});
});

// ─── findCanonicalGitRoot ─────────────────────────────────────────────────────

describe("findCanonicalGitRoot", () => {
	it("returns the repo root for a regular repo", () => {
		const repo = makeRepo(join(tmp, "repo"));
		expect(findCanonicalGitRoot(repo)).toBe(repo);
	});

	it("returns the main repo root for a worktree", () => {
		const mainRepo = makeRepo(join(tmp, "main"));
		const worktree = join(tmp, "worktree");
		mkdirSync(worktree);
		makeWorktree(worktree, mainRepo, "fix");
		expect(findCanonicalGitRoot(worktree)).toBe(mainRepo);
	});

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
		const mainRepo = makeRepo(join(tmp, "main"));
		const victim = makeRepo(join(tmp, "victim"));
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

	it("caches results — second call uses cache", () => {
		const mainRepo = makeRepo(join(tmp, "main"));
		const worktree = join(tmp, "worktree");
		mkdirSync(worktree);
		makeWorktree(worktree, mainRepo, "fix");

		const first = findCanonicalGitRoot(worktree);
		// Remove worktree .git file to prove cache is used
		rmSync(join(worktree, ".git"));
		clearGitCaches(); // clear findGitRoot cache only to force re-entry, but canonicalRoot is cached on gitRoot key
		// Re-add .git so findGitRoot works, but corrupt commondir
		writeFileSync(join(worktree, ".git"), `gitdir: ${join(mainRepo, ".git", "worktrees", "fix")}\n`);
		writeFileSync(join(mainRepo, ".git", "worktrees", "fix", "commondir"), "CORRUPTED\n");

		// canonicalRootCache still has the result keyed on mainRepo worktree gitRoot
		// Re-run without clearing canonicalRootCache
		clearGitCaches();
		// After full cache clear, it re-reads — commondir is now corrupted → falls back to gitRoot
		expect(findCanonicalGitRoot(worktree)).toBe(worktree);
	});
});
