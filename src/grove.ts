/**
 * The Grove reader.
 *
 * Grove is the source of truth for what Trees exist. `grove --json` emits
 * {schemaVersion, command, outcome, targets, diagnostics, detail}; `schemaVersion` is what
 * this validates against and `outcome` is what separates a completed operation from a
 * partial one, so `new` projects only completed outcomes.
 *
 * Tree directories are <grove root>/trees/<grove>@<repo>. Directory listing is the fallback
 * when `grove --json` is not available, because the live evidence establishes that layout.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { GroveCmuxError } from './errors.ts';
import { readLedger } from './ledger.ts';

const LEDGER_DIRNAME = '.grove-cmux';

const execFileAsync = promisify(execFile);

export const SUPPORTED_GROVE_SCHEMA_VERSIONS = [1];

export interface Tree {
  /** Full directory name, e.g. "feat-checkout@storefront-web". */
  name: string;
  /** The half after the "@", used as the workspace title. */
  shortName: string;
  path: string;
  existsOnDisk: boolean;
}

export interface Grove {
  name: string;
  root: string;
  trees: Tree[];
  /** Directories under trees/ that are not named <grove>@<repo>, reported and never projected. */
  skipped: string[];
}

export interface GroveJson {
  schemaVersion?: number;
  command?: string;
  outcome?: string;
  targets?: unknown;
  diagnostics?: unknown;
  detail?: unknown;
}

export function treesDir(groveRoot: string): string {
  return join(groveRoot, 'trees');
}

/**
 * Read a Grove from disk. This is deliberately filesystem-first: the Tree set is a
 * directory listing, which is the fact `sync` reconciles against, and it needs no
 * subprocess. `grove --json` is consulted for the machine contract, not for the Tree list.
 */
export function readGroveFromDisk(groveRoot: string): Grove {
  const root = resolve(groveRoot);
  if (!existsSync(root)) {
    const archivedAt = archivedGroveWithLedger(root);
    throw new GroveCmuxError(
      'E_PRECONDITION',
      `the Grove root does not exist: ${root}`,
      archivedAt ? { grove_root: root, archived_at: archivedAt } : { grove_root: root },
      archivedAt
        ? `this Grove is archived; run grove-cmux against ${archivedAt}`
        : undefined,
    );
  }
  const name = basename(root);
  const dir = treesDir(root);

  // A directory is not a Grove just because it exists. Without this a mistyped path projects
  // an empty group named after whatever directory the person happened to be in, which for a
  // tool whose posture is refuse-rather-than-guess is the wrong outcome.
  if (!existsSync(dir) && !existsSync(join(root, LEDGER_DIRNAME))) {
    throw new GroveCmuxError(
      'E_PRECONDITION',
      `${root} is not a Grove: it has no trees/ directory and no projection ledger`,
      { grove_root: root, expected: join(root, 'trees') },
      'pass the path of a Grove root, or run grove new to create one',
    );
  }

  const trees: Tree[] = [];
  const skipped: string[] = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      // Grove names its Trees <grove>@<repo>. Anything else under trees/ is someone's
      // scratch directory, and projecting it would invent a Tree that Grove does not have.
      if (!entry.startsWith(`${name}@`)) {
        skipped.push(entry);
        continue;
      }
      trees.push({
        name: entry,
        shortName: shortTreeName(entry, name),
        path: p,
        existsOnDisk: true,
      });
    }
  }
  return { name, root, trees, skipped };
}

/**
 * Return an archive hint only when the conventional sibling contains a readable ledger for
 * this exact Grove. This is diagnostic path arithmetic: it grants no ownership and never
 * supplies a mutation target. Errors are intentionally absent evidence because nobody named
 * the archive path, so a bad candidate must not turn a missing-root refusal into E_LEDGER.
 */
function archivedGroveWithLedger(missingRoot: string): string | null {
  const grovesDir = dirname(missingRoot);
  if (basename(grovesDir) !== 'groves') return null;
  const groveName = basename(missingRoot);
  const archivedAt = join(dirname(grovesDir), 'archives', groveName);
  try {
    return readLedger(archivedAt)?.grove === groveName ? archivedAt : null;
  } catch {
    return null;
  }
}

export function shortTreeName(treeDirName: string, groveName: string): string {
  const prefix = `${groveName}@`;
  return treeDirName.startsWith(prefix) ? treeDirName.slice(prefix.length) : treeDirName;
}

export interface GroveRunnerOptions {
  bin?: string;
}

export class GroveRunner {
  private readonly bin: string;

  constructor(opts: GroveRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.GROVE_BIN ?? 'grove';
  }

  /** Run `grove --json <args...>` and validate the envelope. */
  async json(args: string[], cwd?: string): Promise<GroveJson> {
    let stdout: string;
    try {
      const res = await execFileAsync(this.bin, ['--json', ...args], {
        cwd: cwd ?? process.cwd(),
        env: process.env,
        maxBuffer: 32 * 1024 * 1024,
      });
      stdout = res.stdout;
    } catch (e) {
      const err = e as { code?: string | number; stderr?: string; stdout?: string };
      if (err.code === 'ENOENT') {
        throw new GroveCmuxError(
          'E_GROVE_FAILED',
          `the grove binary "${this.bin}" is not on PATH`,
          { bin: this.bin, args },
          'install grove, or set GROVE_BIN to its path',
        );
      }
      // `grove --json` reports a refusal as {"error":{…}} on stdout and writes nothing to
      // stderr, so without reading stdout the evidence carried no reason at all.
      const groveError = groveJsonError((err.stdout ?? '').toString());
      throw new GroveCmuxError(
        'E_GROVE_FAILED',
        groveError?.what ? `grove refused: ${groveError.what}` : 'grove exited non-zero',
        {
          bin: this.bin,
          args: ['--json', ...args],
          exit_code: typeof err.code === 'number' ? err.code : null,
          stderr: (err.stderr ?? '').toString().trim().slice(0, 2000) || null,
          ...(groveError ? { grove_error: groveError } : {}),
        },
      );
    }
    return parseGroveJson(stdout, ['--json', ...args]);
  }

  /**
   * The agents defined for the Grove workspace containing `cwd`.
   *
   * `grove --json agent ls` answers `{"agents":[…],"default":null}` with no schemaVersion, so
   * it cannot go through json(); parsing it leniently here is deliberate.
   *
   * Returns null when grove could not answer at all. A caller uses this to refuse *before*
   * mutating, and null must not become a refusal: failing to check is not evidence that the
   * agent is missing.
   *
   * One case is not "could not answer" but "provably will not run": an absolute GROVE_BIN
   * that does not exist. That same string is what `agentCommand` puts in the terminal, and an
   * absolute path cannot resolve differently there, so proceeding would project the Grove and
   * then report a handoff into a command that cannot exist. That throws.
   *
   * A bare name stays lenient. `grove` missing from *this* process's PATH says nothing about
   * the login shell cmux starts the surface in, which is the one place PATH is not ours.
   */
  async listAgents(cwd: string): Promise<GroveAgent[] | null> {
    let stdout: string;
    try {
      const res = await execFileAsync(this.bin, ['--json', 'agent', 'ls'], {
        cwd,
        env: process.env,
        maxBuffer: 8 * 1024 * 1024,
      });
      stdout = res.stdout;
    } catch (e) {
      if ((e as { code?: string | number }).code === 'ENOENT' && isAbsolute(this.bin)) {
        throw new GroveCmuxError(
          'E_GROVE_FAILED',
          `the grove binary "${this.bin}" does not exist`,
          { bin: this.bin, args: ['--json', 'agent', 'ls'] },
          'fix GROVE_BIN, or unset it to resolve grove from PATH in the terminal',
        );
      }
      return null;
    }
    try {
      const parsed = JSON.parse(stdout.trim()) as { agents?: unknown };
      if (!Array.isArray(parsed.agents)) return null;
      return parsed.agents.flatMap((a) => {
        const o = a as Record<string, unknown>;
        return typeof o.name === 'string'
          ? [{ name: o.name, available: o.available !== false }]
          : [];
      });
    } catch {
      return null;
    }
  }
}

export interface GroveAgent {
  name: string;
  available: boolean;
}

/** The `error` object of a `grove --json` refusal, or null when stdout is not one. */
export function groveJsonError(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as { error?: unknown };
    const e = parsed?.error;
    return e && typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseGroveJson(stdout: string, args: string[]): GroveJson {
  const text = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GroveCmuxError('E_GROVE_SCHEMA', 'grove emitted output that is not JSON', {
      args,
      stdout: text.slice(0, 2000),
    });
  }
  const j = parsed as GroveJson;
  if (typeof j.schemaVersion !== 'number') {
    throw new GroveCmuxError('E_GROVE_SCHEMA', 'grove JSON carries no schemaVersion', {
      args,
      keys: Object.keys(j ?? {}),
    });
  }
  if (!SUPPORTED_GROVE_SCHEMA_VERSIONS.includes(j.schemaVersion)) {
    throw new GroveCmuxError(
      'E_GROVE_SCHEMA',
      `grove emitted schemaVersion ${j.schemaVersion}, which this build does not understand`,
      { args, schemaVersion: j.schemaVersion, supported: SUPPORTED_GROVE_SCHEMA_VERSIONS },
    );
  }
  return j;
}

/**
 * AC-11: project only completed outcomes.
 *
 * Real grove says `complete`. This originally checked only for `completed`, which the fake
 * grove in the test suite emitted because that is what the author assumed — so a perfectly
 * successful `grove new` was refused as a partial outcome, and no test could see it.
 */
export function isCompletedOutcome(j: GroveJson): boolean {
  return (
    j.outcome === 'complete' ||
    j.outcome === 'completed' ||
    j.outcome === 'success' ||
    j.outcome === 'ok'
  );
}

/**
 * Find the Grove root in a `grove --json new` payload.
 *
 * `targets` is an **array** of per-Tree records, not an object, and each carries
 * `selector.path` pointing at the Tree: `<workspace>/groves/<grove>/trees/<grove>@<repo>`.
 * The Grove root is therefore two levels up from any of them. Reading `targets.root` off what
 * is actually an array yielded undefined and fell back to `<cwd>/<name>`, which is the wrong
 * directory in every real workspace.
 */
export function groveRootFromJson(j: GroveJson): string | null {
  // `detail` names the Grove root directly when grove has one to give.
  const detail = j.detail as Record<string, unknown> | undefined;
  if (detail && !Array.isArray(detail) && typeof detail.path === 'string' && detail.path) {
    return detail.path;
  }

  const targets = j.targets;
  if (Array.isArray(targets)) {
    for (const t of targets) {
      const sel = (t as { selector?: { path?: unknown; tree?: unknown } })?.selector;
      const path = sel?.path;
      if (typeof path !== 'string' || path.length === 0) continue;
      // The shape depends on the action. A `worktree-add` selector names a Tree, at
      // <root>/trees/<tree>; a `create-empty-grove` selector names the Grove root itself.
      // Treating both as Tree paths put an empty Grove's root two directories too high.
      return typeof sel?.tree === 'string' && sel.tree.length > 0
        ? dirname(dirname(path))
        : path;
    }
  }
  // Older or narrower shapes may name the root directly.
  for (const src of [targets, detail] as Array<Record<string, unknown> | undefined>) {
    if (!src || Array.isArray(src) || typeof src !== 'object') continue;
    for (const key of ['root', 'path', 'grove_root', 'grove_path']) {
      const v = src[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}
