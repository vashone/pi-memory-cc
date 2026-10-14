/**
 * Git root resolution utilities.
 *
 * Pure filesystem implementation — does not require git to be installed.
 * Mirrors Claude Code's findGitRoot + findCanonicalGitRoot logic including
 * the worktree security validation.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * The physical path of `path` (symlinks resolved), the form git records and
 * pi's CLI passes as cwd. Falls back to the resolved path if it doesn't exist.
 */
export function physicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Walk up the directory tree looking for a .git directory or file.
 * Returns the directory containing .git, or null if not found.
 * Walks the physical path, like git does, so a symlinked path finds the same
 * root as its target.
 * Pure filesystem — does not require git to be installed.
 */
export function findGitRoot(startPath: string): string | null {
	let current = physicalPath(startPath);
	const root = current.substring(0, current.indexOf(sep) + 1) || sep;
	let result: string | null = null;

	while (current !== root) {
		try {
			const stat = statSync(join(current, ".git"));
			if (stat.isDirectory() || stat.isFile()) {
				result = current.normalize("NFC");
				break;
			}
		} catch {
			// .git doesn't exist at this level, continue up
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	// Check root directory as well
	if (result === null) {
		try {
			const stat = statSync(join(root, ".git"));
			if (stat.isDirectory() || stat.isFile()) {
				result = root.normalize("NFC");
			}
		} catch {}
	}

	return result;
}

/**
 * Resolve a git root to the canonical main repository root.
 * For a regular repo this is a no-op. For a worktree, follows the
 * `.git` file → `gitdir:` → `commondir` chain to find the main repo's
 * working directory so all worktrees share the same memory directory.
 *
 * Includes the same security validation as Claude Code:
 *   1. worktreeGitDir must be a direct child of <commonDir>/worktrees/
 *   2. <worktreeGitDir>/gitdir must point back to <gitRoot>/.git
 * Both checks prevent a malicious repo from hijacking memory via a
 * crafted .git file or commondir pointer.
 *
 * Submodules (.git is a file but no commondir) fall through to gitRoot.
 */
export function findCanonicalGitRoot(startPath: string): string | null {
	const gitRoot = findGitRoot(startPath);
	if (!gitRoot) return null;

	let result: string;
	try {
		const gitContent = readFileSync(join(gitRoot, ".git"), "utf-8").trim();
		if (!gitContent.startsWith("gitdir:")) {
			result = gitRoot;
		} else {
			const worktreeGitDir = resolve(gitRoot, gitContent.slice("gitdir:".length).trim());
			const commonDir = resolve(
				worktreeGitDir,
				readFileSync(join(worktreeGitDir, "commondir"), "utf-8").trim(),
			);

			if (resolve(dirname(worktreeGitDir)) !== join(commonDir, "worktrees")) {
				result = gitRoot;
			} else {
				// `git worktree add --relative-paths` writes the backlink relative to worktreeGitDir
				const backlink = realpathSync(
					resolve(worktreeGitDir, readFileSync(join(worktreeGitDir, "gitdir"), "utf-8").trim()),
				);
				if (backlink !== join(realpathSync(gitRoot), ".git")) {
					result = gitRoot;
				} else if (commonDir.split(sep).pop() !== ".git") {
					// Bare-repo worktrees: commonDir isn't a .git directory
					result = commonDir.normalize("NFC");
				} else {
					result = dirname(commonDir).normalize("NFC");
				}
			}
		}
	} catch {
		result = gitRoot;
	}

	return result;
}
