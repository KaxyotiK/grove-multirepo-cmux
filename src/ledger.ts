/**
 * The projection ledger.
 *
 * Every cmux-visible field failed a live test as an identity carrier: description and
 * custom_title are user-editable, current_directory is the terminal's live cwd so `cd src`
 * changes it, external_id exists on groups only and only on unreleased builds, and replaying
 * operation_id created a second workspace instead of deduping. The workspace UUID is the one
 * stable handle, and it survives a cmux restart.
 *
 * So the ledger is the sole answer to "did we create this". cmux is what the ledger is
 * checked against, never what identity is read from. Being in the right place is never
 * evidence of being ours.
 *
 * Writes are temp-file plus rename, and they happen after every single workspace.create
 * rather than once per run. That is what removes crash recovery as an argument for adopting
 * a workspace by path: the window in which cmux runs ahead of the ledger is one RPC round
 * trip, not a whole projection.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { GroveCmuxError } from './errors.ts';

export const LEDGER_SCHEMA = 1;
export const LEDGER_DIR = '.grove-cmux';
export const LEDGER_FILE = 'projection.json';

export interface Ledger {
  schema: number;
  grove: string;
  cmux_build: string | null;
  window_id: string | null;
  group_id: string | null;
  anchor_workspace_id: string | null;
  /** tree name -> workspace uuid. Load-bearing: it is what survives an ungroup. */
  trees: Record<string, string>;
}

export function ledgerPath(groveRoot: string): string {
  return join(groveRoot, LEDGER_DIR, LEDGER_FILE);
}

export function emptyLedger(groveName: string): Ledger {
  return {
    schema: LEDGER_SCHEMA,
    grove: groveName,
    cmux_build: null,
    window_id: null,
    group_id: null,
    anchor_workspace_id: null,
    trees: {},
  };
}

export function readLedger(groveRoot: string): Ledger | null {
  const path = ledgerPath(groveRoot);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new GroveCmuxError('E_LEDGER', 'the projection ledger could not be read', {
      path,
      cause: (e as Error).message,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new GroveCmuxError('E_LEDGER', 'the projection ledger is not valid JSON', {
      path,
      cause: (e as Error).message,
    });
  }
  const l = parsed as Partial<Ledger>;
  if (typeof l.schema !== 'number') {
    throw new GroveCmuxError('E_LEDGER', 'the projection ledger has no schema field', { path });
  }
  if (l.schema > LEDGER_SCHEMA) {
    throw new GroveCmuxError(
      'E_LEDGER',
      `the projection ledger was written by schema ${l.schema}, newer than this build understands (${LEDGER_SCHEMA})`,
      { path, ledger_schema: l.schema, supported_schema: LEDGER_SCHEMA },
      'upgrade grove-cmux; do not delete the ledger, it is the only record of ownership',
    );
  }
  return {
    schema: l.schema,
    grove: l.grove ?? '',
    cmux_build: l.cmux_build ?? null,
    window_id: l.window_id ?? null,
    group_id: l.group_id ?? null,
    anchor_workspace_id: l.anchor_workspace_id ?? null,
    trees: l.trees ?? {},
  };
}

/** Atomic: write a sibling temp file, then rename over the target. */
export function writeLedger(groveRoot: string, ledger: Ledger): void {
  const path = ledgerPath(groveRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw new GroveCmuxError('E_LEDGER', 'the projection ledger could not be written', {
      path,
      cause: (e as Error).message,
    });
  }
}

/** Remove projection ownership only after a caller has verified every planned close. */
export function forgetProjection(groveRoot: string): void {
  const path = dirname(ledgerPath(groveRoot));
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (e) {
    throw new GroveCmuxError('E_LEDGER', 'the projection ledger could not be removed', {
      path,
      cause: (e as Error).message,
    });
  }
}

/**
 * A ledger writer that persists after every mutation. Callers hold one of these for the
 * duration of a projection and call `recordTree` immediately after each workspace.create,
 * so a crash mid-run leaves the ledger describing exactly what exists.
 */
export class LedgerWriter {
  private readonly root: string;
  private ledger: Ledger;
  /** Every persisted state, in order. Tests assert the incremental property from this. */
  readonly writes: Ledger[] = [];

  constructor(root: string, ledger: Ledger) {
    this.root = root;
    this.ledger = ledger;
  }

  current(): Ledger {
    return structuredClone(this.ledger);
  }

  private flush(): void {
    writeLedger(this.root, this.ledger);
    this.writes.push(structuredClone(this.ledger));
  }

  recordTree(tree: string, workspaceId: string): void {
    this.ledger.trees[tree] = workspaceId;
    this.flush();
  }

  dropTree(tree: string): void {
    delete this.ledger.trees[tree];
    this.flush();
  }

  recordGroup(p: { groupId: string; anchorWorkspaceId: string; windowId: string }): void {
    this.ledger.group_id = p.groupId;
    this.ledger.anchor_workspace_id = p.anchorWorkspaceId;
    this.ledger.window_id = p.windowId;
    this.flush();
  }

  /** The recorded build is provenance, not a lock. UUIDs survive upgrades, so sync rewrites it. */
  recordBuild(build: string | null): void {
    this.ledger.cmux_build = build;
    this.flush();
  }

  /** window_id is a hint, verified against the workspace UUIDs; rewriting it is silent. */
  rewriteWindow(windowId: string): void {
    this.ledger.window_id = windowId;
    this.flush();
  }

  clearProjection(): void {
    this.ledger.group_id = null;
    this.ledger.anchor_workspace_id = null;
    this.ledger.window_id = null;
    this.ledger.trees = {};
    this.flush();
  }
}
