/**
 * D1: which window a command acts on.
 *
 * The ladder, first hit winning:
 *   1. --window <id>
 *   2. --window focused, or GROVE_CMUX_WINDOW=focused — the focused fallback under the
 *      person's own signature rather than as a default
 *   3. the ledger's window_id, verified against our workspace UUIDs before it is trusted,
 *      and skipped entirely under --relocate
 *   4. caller context, when cmux supplies one
 *   5. exactly one cmux window — the only satisfying assignment, so not a guess
 *   6. otherwise mutations refuse with E_AMBIGUOUS_TARGET; reads never refuse, they
 *      enumerate every window
 *
 * Rules 3 and 4 are in that order because caller context is ambient and the ledger is
 * evidence about this Grove in particular. An agent running in a cmux terminal in window B
 * asking about a Grove projected in window A used to be told, with exit 0, that every Tree
 * was missing: caller won, window B was observed, and nothing of ours was in it. A verified
 * ledger window is not a guess — it still holds our UUIDs — so it outranks where the process
 * happens to be typing. --relocate is the deliberate exception: there "here" is the whole
 * point, so the ledger must not pull the run back to the old window.
 *
 * The focused window is not the default because the premise of the decision is that the
 * wrapper runs from a shell outside cmux, so cmux is backgrounded by construction and
 * `identify` reports the last-focused window rather than the one the person is looking at.
 * A refusal costs one re-run with a flag; a wrong-window projection costs N+1 objects to
 * hunt down in a window the person was not in.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CmuxClient, CmuxWindow } from './cmux.ts';
import { GroveCmuxError } from './errors.ts';
import type { Ledger } from './ledger.ts';

const execFileAsync = promisify(execFile);

export type WindowSource = 'flag' | 'focused' | 'caller' | 'ledger' | 'sole-window';

export interface ResolvedWindow {
  id: string;
  source: WindowSource;
}

export interface ResolveWindowInput {
  client: CmuxClient;
  flag?: string | null;
  ledger?: Ledger | null;
  /** Reads enumerate; mutations refuse. */
  mutating: boolean;
  /** --relocate: the person is naming this window on purpose, so skip the ledger. */
  relocate?: boolean;
  /** Injected in tests instead of shelling out to `cmux identify`. */
  identify?: () => Promise<{ caller?: string | null; focused?: string | null }>;
}

export async function resolveWindow(input: ResolveWindowInput): Promise<ResolvedWindow> {
  const windows = await input.client.listWindows();
  const flag = input.flag ?? process.env.GROVE_CMUX_WINDOW ?? null;

  if (flag && flag !== 'focused') {
    if (!windows.some((w) => w.id === flag)) {
      throw new GroveCmuxError('E_CMUX_TARGET', `no cmux window with id ${flag}`, {
        window_id: flag,
        windows: windows.map((w) => w.id),
      });
    }
    return { id: flag, source: 'flag' };
  }

  const identify = input.identify ?? (() => identifyViaCli(input.client));

  if (flag === 'focused') {
    const { focused } = await identify();
    if (!focused) {
      throw new GroveCmuxError('E_CMUX_TARGET', 'cmux reports no focused window', {
        requested: 'focused',
      });
    }
    return { id: focused, source: 'focused' };
  }

  if (!input.relocate) {
    const fromLedger = await verifyLedgerWindow(input.client, input.ledger ?? null, windows);
    if (fromLedger) return { id: fromLedger, source: 'ledger' };
  }

  const { caller } = await identify();
  if (caller) return { id: caller, source: 'caller' };

  if (windows.length === 1) return { id: windows[0]!.id, source: 'sole-window' };

  if (!input.mutating) {
    throw new EnumerateAllWindows(windows);
  }

  throw new GroveCmuxError(
    'E_AMBIGUOUS_TARGET',
    `${windows.length} cmux windows are open and nothing named which one to use`,
    { windows: windows.map((w) => ({ id: w.id, title: w.title })) },
    `pass --window <id>, one of: ${windows.map((w) => w.id).join(', ')}`,
  );
}

/**
 * A read with no window does not refuse. It reports every window, so the discovery path
 * needs no flag and anyone who then has to pass `--window` already has the id on screen.
 */
export class EnumerateAllWindows extends Error {
  readonly windows: CmuxWindow[];
  constructor(windows: CmuxWindow[]) {
    super('enumerate all windows');
    this.name = 'EnumerateAllWindows';
    this.windows = windows;
  }
}

/**
 * The ledger's window_id is a hint, not identity. It is trusted only if the window it names
 * still exists and still holds at least one of our recorded workspace UUIDs. If the window is
 * gone, the caller routes to E_PROJECTION_CONFLICT with a --relocate remedy, never to
 * E_CMUX_TARGET: the person named nothing, the ledger did, so "you named a bad target" is the
 * wrong remedy.
 */
async function verifyLedgerWindow(
  client: CmuxClient,
  ledger: Ledger | null,
  windows: CmuxWindow[],
): Promise<string | null> {
  if (!ledger?.window_id) return null;
  const uuids = new Set(Object.values(ledger.trees));
  if (ledger.anchor_workspace_id) uuids.add(ledger.anchor_workspace_id);
  if (uuids.size === 0) {
    return windows.some((w) => w.id === ledger.window_id) ? ledger.window_id : null;
  }
  if (windows.some((w) => w.id === ledger.window_id)) {
    const ws = await client.listWorkspaces(ledger.window_id);
    if (ws.some((w) => uuids.has(w.id))) return ledger.window_id;
  }
  return null;
}

/** Scan every window for our recorded UUIDs. Used by --relocate and by conflict detection. */
export async function findLedgerWindow(
  client: CmuxClient,
  ledger: Ledger,
): Promise<{ windowId: string; found: number } | null> {
  const uuids = new Set(Object.values(ledger.trees));
  if (ledger.anchor_workspace_id) uuids.add(ledger.anchor_workspace_id);
  if (uuids.size === 0) return null;
  for (const w of await client.listWindows()) {
    let ws;
    try {
      ws = await client.listWorkspaces(w.id);
    } catch {
      continue;
    }
    const found = ws.filter((x) => uuids.has(x.id)).length;
    if (found > 0) return { windowId: w.id, found };
  }
  return null;
}

async function identifyViaCli(
  client: CmuxClient,
): Promise<{ caller: string | null; focused: string | null }> {
  const bin = process.env.GROVE_CMUX_CMUX_BIN ?? 'cmux';
  void client;
  try {
    const res = await execFileAsync(bin, ['identify', '--json', '--id-format', 'uuids'], {
      env: { ...process.env, CMUX_QUIET: '1' },
    });
    const parsed = JSON.parse(res.stdout) as {
      caller?: { window_id?: string } | null;
      focused?: { window_id?: string } | null;
    };
    return {
      caller: parsed.caller?.window_id ?? null,
      focused: parsed.focused?.window_id ?? null,
    };
  } catch {
    return { caller: null, focused: null };
  }
}
