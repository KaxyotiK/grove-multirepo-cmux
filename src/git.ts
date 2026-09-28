/**
 * Git worktree resolution.
 *
 * A workspace's `current_directory` is the terminal's live cwd, so a person sitting in
 * <tree>/src reports that path rather than the Tree. Resolving with
 * `git rev-parse --show-toplevel` maps it back to the Tree, and maps /tmp to nothing.
 *
 * This resolution is used for *reporting only*. It never adopts. Path resolution proves the
 * path, not the ownership, and the converged rule is: no adoption by path at any depth,
 * including an exact match at the Tree root. There is deliberately no adoption flag: a
 * workspace becomes ours by being created by us, and by nothing else.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const cache = new Map<string, string | null>();

export function resolveWorktree(dir: string | null | undefined): string | null {
  if (!dir) return null;
  if (cache.has(dir)) return cache.get(dir) ?? null;
  let result: string | null = null;
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    result = realpathQuiet(out.trim());
  } catch {
    result = null;
  }
  cache.set(dir, result);
  return result;
}

export function realpathQuiet(p: string | null | undefined): string | null {
  if (!p) return null;
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Test seam: lets the module suites drive resolution without a real repository. */
export function __setWorktreeForTest(dir: string, worktree: string | null): void {
  cache.set(dir, worktree);
}

export function __clearWorktreeCache(): void {
  cache.clear();
}
