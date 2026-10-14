/**
 * Git checkouts for tests.
 *
 * Uses real `git init` and `git worktree add` when git supports
 * --relative-paths (2.48+). Otherwise writes fixtures that copy the files git
 * writes, so the tests still run where git is missing or older.
 *
 * Pass physical paths: git records physical paths, and so do the fixtures.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { basename, join, relative } from "node:path";

export type WorktreePaths = "absolute" | "relative";

function gitSupportsRelativePaths(): boolean {
	try {
		const version = execFileSync("git", ["--version"], { encoding: "utf-8", stdio: "pipe" });
		const [, major, minor] = version.match(/(\d+)\.(\d+)/) ?? [];
		return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 48);
	} catch {
		return false;
	}
}

const usesRealGit = gitSupportsRelativePaths();

// Isolate git from the user's config and from GIT_DIR & co. set by hooks.
const gitEnv = {
	...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
	GIT_CONFIG_GLOBAL: devNull,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe" });
}

/** Create a main working tree at `dir`, with a commit for worktrees to check out. */
export function initRepo(dir: string): string {
	if (usesRealGit) {
		mkdirSync(dir, { recursive: true });
		git(dir, "init", "-q");
		git(dir, "commit", "-q", "--allow-empty", "-m", "init");
	} else {
		mkdirSync(join(dir, ".git", "worktrees"), { recursive: true });
	}
	return dir;
}

/**
 * Add a worktree of `mainRepo` at `worktree`. `git worktree add` creates:
 *   <worktree>/.git                            — `gitdir:` pointer to <mainRepo>/.git/worktrees/<name>
 *   <mainRepo>/.git/worktrees/<name>/gitdir    — backlink to <worktree>/.git
 *   <mainRepo>/.git/worktrees/<name>/commondir — `../..`, i.e. <mainRepo>/.git
 * With relative paths (--relative-paths), the pointer is relative to <worktree>
 * and the backlink is relative to <mainRepo>/.git/worktrees/<name>.
 */
export function addWorktree(mainRepo: string, worktree: string, paths: WorktreePaths): string {
	if (usesRealGit) {
		git(mainRepo, "worktree", "add", "-q", ...(paths === "relative" ? ["--relative-paths"] : []), worktree);
		return worktree;
	}

	const worktreeGitDir = join(mainRepo, ".git", "worktrees", basename(worktree));
	const worktreeDotGit = join(worktree, ".git");
	const pointer = paths === "relative" ? relative(worktree, worktreeGitDir) : worktreeGitDir;
	const backlink = paths === "relative" ? relative(worktreeGitDir, worktreeDotGit) : worktreeDotGit;
	mkdirSync(worktreeGitDir, { recursive: true });
	mkdirSync(worktree, { recursive: true });
	writeFileSync(worktreeDotGit, `gitdir: ${pointer}\n`);
	writeFileSync(join(worktreeGitDir, "gitdir"), `${backlink}\n`);
	writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
	return worktree;
}
