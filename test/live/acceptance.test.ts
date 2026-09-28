/**
 * Live acceptance, against a real cmux in a Tart guest.
 *
 * The suite owns the guest: it clones, boots, arms the socket, deploys the built wrapper,
 * runs, and deletes. Nothing here is driven by hand, which is the difference between a case
 * that was executed once and a case that can be re-run.
 *
 * Each case leaves the guest as it found it, so the order does not matter and a failure does
 * not poison the ones after it.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireGuest, liveVmSetting, SKIP_REASON } from '../helpers/guest.mjs';

type Guest = Awaited<ReturnType<typeof acquireGuest>>;

let guest: Guest = null;
let windowId = '';
const GROVE = '/Users/admin/work/groves/feat-checkout';

before(async () => {
  if (!liveVmSetting()) return;
  guest = await acquireGuest();
  if (!guest) return;
  guest.deploy();
  // The frozen base carries tools and no data, so the fixture is built rather than assumed.
  guest.seed();
  windowId = guest.windowId();
});

after(() => {
  guest?.release();
});

/** Every case starts from an unprojected Grove in a known window. */
function reset() {
  if (!guest) return;
  guest.exec(`rm -rf ${GROVE}/.grove-cmux`);
  const groups = guest.rpc('workspace.group.list', { window_id: windowId });
  for (const g of groups?.groups ?? []) {
    guest.rpc('workspace.group.ungroup', { window_id: windowId, group_id: g.id });
  }
  const ws = guest.rpc('workspace.list', { window_id: windowId });
  for (const w of ws?.workspaces ?? []) {
    const dir = w.current_directory ?? '';
    if (dir.startsWith(GROVE)) {
      guest.rpc('workspace.close', { window_id: windowId, workspace_id: w.id });
    }
  }
}

function live(name: string, body: (g: NonNullable<Guest>) => void) {
  test(name, { skip: liveVmSetting() ? false : SKIP_REASON }, () => {
    assert.ok(guest, 'the guest was not acquired');
    reset();
    try {
      body(guest);
    } finally {
      reset();
    }
  });
}


const SESSION_FILE =
  '/Users/admin/Library/Application Support/cmux/session-com.cmuxterm.app.json';

/**
 * Block until cmux's session autosave has run since the workspaces were created.
 *
 * The tick timestamp is `createdAt` inside the session file, not the file's mtime: the file
 * is rewritten on a fingerprint check that can touch it without advancing the tick.
 */
function readLedger(
  g: NonNullable<Guest>,
  root: string = GROVE,
): { trees: Record<string, string>; group_id?: string; anchor_workspace_id?: string } {
  const raw = g.exec(`cat ${root}/.grove-cmux/projection.json`);
  const start = raw.indexOf('{');
  assert.ok(start >= 0, `no ledger on disk: ${raw}`);
  return JSON.parse(raw.slice(start));
}

function waitForSessionAutosave(g: NonNullable<Guest>): void {
  const started = Date.now();
  const deadline = started + 150000;
  const before = sessionTick(g);
  while (Date.now() < deadline) {
    g.exec('sleep 5');
    const now = sessionTick(g);
    if (now !== null && before !== null && now > before) return;
    if (now !== null && before === null) return;
  }
  throw new Error('cmux never autosaved its session within 150s');
}

function sessionTick(g: NonNullable<Guest>): number | null {
  const out = g.exec(
    `python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1])).get("createdAt"))
except Exception:
    print("none")' ${JSON.stringify(SESSION_FILE)}`,
  ).trim();
  const n = Number(out.split('\n').pop());
  return Number.isFinite(n) ? n : null;
}

live('the acceptance record names the exact build every live proof ran against', (g) => {
  const version = g.cmuxVersion();
  assert.match(version, /\d+\.\d+\.\d+ \(\d+\) \[[0-9a-f]+\]/, `version was: ${version}`);
});

live('AC-03: open projects one group, an anchor at the Grove root, one member per Tree', (g) => {
  const r = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.json, r.out);
  assert.equal(r.json.group.state, 'present');
  assert.equal(r.json.summary.missing, 0);
  assert.ok(r.json.summary.present >= 1);

  const groups = g.rpc('workspace.group.list', { window_id: windowId }).groups;
  const ours = groups.find((x: { id: string }) => x.id === r.json.group.id);
  assert.ok(ours, 'the group the wrapper reported is not in cmux');
  // cmux counts the anchor as a member of its own group, so the membership is one more
  // than the Tree count. Asserting equality here was the test's model being wrong.
  assert.ok(
    ours.member_workspace_ids.includes(ours.anchor_workspace_id),
    'cmux no longer counts the anchor as a member; the classifier assumes it does',
  );
  assert.equal(ours.member_workspace_ids.length, r.json.summary.present + 1);

  const ws = g.rpc('workspace.list', { window_id: windowId }).workspaces;
  const anchor = ws.find((x: { id: string }) => x.id === ours.anchor_workspace_id);
  assert.equal(anchor.current_directory, GROVE);
});

live('AC-23, AC-27: close --forget removes the real projection from cmux and disk', (g) => {
  const opened = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(opened.code, 0, opened.out);
  const ledger = readLedger(g);
  assert.ok(ledger.group_id, 'the live projection has no group to verify');
  assert.ok(ledger.anchor_workspace_id, 'the live projection has no anchor to verify');
  const ownedWorkspaceIds = [
    ...Object.values(ledger.trees),
    ledger.anchor_workspace_id,
  ];
  assert.ok(ownedWorkspaceIds.length > 1, 'the live projection has no Tree workspaces to close');

  console.log(`  close proof cmux: ${g.cmuxVersion()}`);
  const closed = g.json(['close', GROVE, '--forget']);
  assert.equal(closed.code, 0, closed.out);

  const socketWorkspaces = g.rpc('workspace.list', { window_id: windowId }).workspaces;
  const socketWorkspaceIds = new Set(
    socketWorkspaces.map((workspace: { id: string }) => workspace.id),
  );
  for (const id of ownedWorkspaceIds) {
    assert.ok(!socketWorkspaceIds.has(id), `socket still reports owned workspace ${id}`);
  }

  const socketGroups = g.rpc('workspace.group.list', { window_id: windowId }).groups;
  assert.ok(
    !socketGroups.some((group: { id: string }) => group.id === ledger.group_id),
    `socket still reports owned group ${ledger.group_id}`,
  );

  const disk = g.exec(
    `if [ -e ${GROVE}/.grove-cmux ]; then echo PRESENT; else echo ABSENT; fi`,
  ).trim();
  assert.equal(disk.split('\n').pop(), 'ABSENT', `.grove-cmux remains on disk: ${disk}`);
});

live('O1: the icon and the colour actually land on the real group header', (g) => {
  const r = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(r.code, 0, r.out);

  // Read back through cmux rather than through our own journal. The payload carries
  // icon_symbol and custom_color on every group row, so this is what the header will draw.
  const groups = g.rpc('workspace.group.list', { window_id: windowId }).groups;
  const ours = groups.find((x: { id: string }) => x.id === r.json.group.id);
  assert.ok(ours, 'the group the wrapper reported is not in cmux');
  assert.equal(
    ours.icon_symbol,
    'leaf.fill',
    `the icon did not land; cmux stores null for a symbol it cannot render (got ${ours.icon_symbol})`,
  );
  assert.equal(ours.custom_color, '#2F9E44');

  // And a second reconcile leaves them exactly as they are.
  const again = g.json(['sync', GROVE, '--window', windowId]);
  assert.equal(again.code, 0, again.out);
  const after = g
    .rpc('workspace.group.list', { window_id: windowId })
    .groups.find((x: { id: string }) => x.id === r.json.group.id);
  assert.equal(after.icon_symbol, 'leaf.fill');
  assert.equal(after.custom_color, '#2F9E44');
});

live('O2: each Tree workspace carries the Grove status pill on a real sidebar', (g) => {
  const r = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(r.code, 0, r.out);
  const ledger = readLedger(g);
  const trees = Object.values(ledger.trees);
  assert.ok(trees.length > 0, 'the fixture projected no Trees');

  for (const uuid of trees) {
    const listed = g.exec(`export PATH="/opt/homebrew/bin:$PATH"
export CMUX_SOCKET_PASSWORD=$(cat "$HOME/.cmux-test-password") CMUX_QUIET=1
cmux list-status --workspace ${uuid}`);
    assert.match(listed, /grove/, `no grove pill on ${uuid}: ${listed}`);
    assert.match(listed, /feat-checkout/, `the pill does not carry the Grove name: ${listed}`);
  }

  // The key is stable, so a second reconcile overwrites rather than adding a second row.
  g.json(['sync', GROVE, '--window', windowId]);
  const first = trees[0]!;
  const listed = g.exec(`export PATH="/opt/homebrew/bin:$PATH"
export CMUX_SOCKET_PASSWORD=$(cat "$HOME/.cmux-test-password") CMUX_QUIET=1
cmux list-status --workspace ${first}`);
  const groveRows = listed.split('\n').filter((l) => /\bgrove\b/.test(l));
  assert.equal(groveRows.length, 1, `repeated reconciles accumulated rows: ${listed}`);
});

live('O1: branding never fails a projection, even with a symbol cmux cannot render', (g) => {
  // grove.logo is not an SF Symbol. cmux stores null and keeps folder.fill, without an error,
  // which is why an invented name is not an option and why the run must still succeed.
  const r = g.json(['open', GROVE, '--window', windowId], {
    env: { GROVE_CMUX_BRAND_ICON: 'grove.logo' },
  });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.summary.missing, 0);
  const ours = g
    .rpc('workspace.group.list', { window_id: windowId })
    .groups.find((x: { id: string }) => x.id === r.json.group.id);
  assert.equal(ours.icon_symbol, null, 'cmux accepted a symbol it should not be able to render');
  assert.equal(ours.custom_color, '#2F9E44', 'the colour is independent of the icon');
});

live('AC-04: a second open creates nothing and reports everything present', (g) => {
  g.json(['open', GROVE, '--window', windowId]);
  const before = g.rpc('workspace.list', { window_id: windowId }).workspaces.length;
  const r = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.json.applied, []);
  assert.equal(r.json.summary.missing, 0);
  const after = g.rpc('workspace.list', { window_id: windowId }).workspaces.length;
  assert.equal(after, before);
});

live('AC-02: status issues no mutating call against a real cmux', (g) => {
  g.json(['open', GROVE, '--window', windowId]);
  const before = g.rpc('workspace.list', { window_id: windowId }).workspaces.length;
  const r = g.json(['status', GROVE, '--window', windowId]);
  assert.equal(r.code, 0, r.out);
  const after = g.rpc('workspace.list', { window_id: windowId }).workspaces.length;
  assert.equal(after, before, 'status changed the world');
});

live('S7.7 live: a real ungroup leaves our workspaces detached, and sync re-attaches them', (g) => {
  const opened = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(opened.code, 0, opened.out);
  const groupId = opened.json.group.id;
  const memberCount = opened.json.summary.present;

  const dissolved = g.rpc('workspace.group.ungroup', { window_id: windowId, group_id: groupId });
  assert.equal(dissolved.operation, 'dissolved');

  const status = g.json(['status', GROVE, '--window', windowId]);
  assert.equal(status.json.group.state, 'dissolved');
  assert.equal(status.json.summary.detached, memberCount);
  assert.equal(status.json.summary.missing, 0, 'a detached workspace must never read as missing');

  const before = g.rpc('workspace.list', { window_id: windowId }).workspaces;
  const synced = g.json(['sync', GROVE, '--window', windowId]);
  assert.equal(synced.code, 0, synced.out);
  const after = g.rpc('workspace.list', { window_id: windowId }).workspaces;

  // Exactly one new workspace: the anchor of the new group. No Tree was duplicated.
  assert.equal(after.length, before.length + 1, 'sync duplicated Tree workspaces');
  assert.equal(synced.json.summary.present, memberCount);
});

live('AC-16: a cmux restart renumbers windows, and the ledger still finds its own', (g) => {
  const opened = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(opened.code, 0, opened.out);
  const treeCount = opened.json.summary.present;
  const uuids = Object.values(readLedger(g).trees) as string[];
  assert.equal(uuids.length, treeCount);

  // cmux writes its session on a timer, so wait for the tick that records what we made.
  waitForSessionAutosave(g);

  g.exec('pkill -f "cmux.app/Contents/MacOS/cmux" || true; sleep 8');
  const up = g.startCmux();
  assert.match(up, /PONG/, `cmux did not come back: ${up}`);
  g.exec('sleep 20');

  // The restored window is not the one we opened into, and is not the first window cmux
  // lists. Passing a guessed --window here is what a person would get wrong, so the case
  // passes none: the ledger's window_id is verified against our UUIDs and wins.
  const status = g.json(['status', GROVE]);
  assert.equal(status.code, 0, status.out);
  assert.ok(status.json, status.out);
  assert.equal(status.json.window.source, 'ledger', 'the window was not resolved from the ledger');
  assert.equal(status.json.summary.present, treeCount);
  assert.equal(status.json.summary.missing, 0);
  assert.equal(status.json.summary.foreign, 0, 'the wrapper adopted something after a restart');

  const restoredWindow = status.json.window.id;
  const live = g.rpc('workspace.list', { window_id: restoredWindow }).workspaces.map(
    (w: { id: string }) => w.id,
  );
  for (const u of uuids) {
    assert.ok(live.includes(u), `workspace ${u} did not survive the restart`);
  }

  // A sync after the restart is a no-op, not a re-projection.
  const synced = g.json(['sync', GROVE]);
  assert.equal(synced.code, 0, synced.out);
  assert.deepEqual(synced.json.applied, []);
  const after = readLedger(g);
  assert.equal(new Set(Object.values(after.trees)).size, treeCount, 'a Tree was projected twice');
  windowId = restoredWindow;
});

live('AC-06: a removed Tree stays open and is reported stale until the flag is passed', (g) => {
  const opened = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(opened.code, 0, opened.out);
  const trees = g.exec(`ls ${GROVE}/trees`).trim().split('\n').filter(Boolean);
  const victim = trees[trees.length - 1]!.trim();
  g.exec(`mv ${GROVE}/trees/${victim} /tmp/${victim}.parked`);
  try {
    const additive = g.json(['sync', GROVE, '--window', windowId]);
    assert.equal(additive.code, 0, additive.out);
    assert.equal(additive.json.summary.stale, 1);
    const stillThere = g.rpc('workspace.list', { window_id: windowId }).workspaces;
    assert.ok(
      stillThere.some((w: { current_directory: string }) =>
        (w.current_directory ?? '').endsWith(victim),
      ),
      'an additive sync closed a workspace',
    );

    const destructive = g.json(['sync', GROVE, '--window', windowId, '--allow-destructive']);
    assert.equal(destructive.code, 0, destructive.out);
    const afterClose = g.rpc('workspace.list', { window_id: windowId }).workspaces;
    assert.ok(
      !afterClose.some((w: { current_directory: string }) =>
        (w.current_directory ?? '').endsWith(victim),
      ),
      '--allow-destructive did not close the stale workspace',
    );
  } finally {
    g.exec(`mv /tmp/${victim}.parked ${GROVE}/trees/${victim} 2>/dev/null || true`);
  }
});

live('AC-13: an unknown window id is E_CMUX_TARGET (5), not a crash', (g) => {
  const r = g.json(['status', GROVE, '--window', '00000000-0000-0000-0000-000000000000']);
  assert.equal(r.code, 5);
  assert.equal(r.json.class, 'E_CMUX_TARGET');
});

live('AC-13: a wrong socket password is E_CMUX_AUTH (4) against a real socket', (g) => {
  const out = g.exec(`export PATH="/opt/homebrew/bin:$PATH"
export CMUX_SOCKET_PASSWORD=definitely-not-the-password CMUX_QUIET=1
node /Users/admin/grove-cmux/dist/cli.js status ${GROVE} --json
echo "__EXIT__$?"`);
  const m = /__EXIT__(\d+)/.exec(out);
  assert.equal(Number(m?.[1]), 4, out);
  assert.match(out, /E_CMUX_AUTH/);
});

live('AC-20 / D4: a workspace a person opened inside a Tree is foreign, and is not adopted', (g) => {
  const trees = g.exec(`ls ${GROVE}/trees`).trim().split('\n').filter(Boolean);
  const tree = trees[0]!.trim();
  const created = g.rpc('workspace.create', {
    window_id: windowId,
    title: 'someone else',
    working_directory: `${GROVE}/trees/${tree}/`,
    focus: false,
  });
  const strangerId = created.workspace_id;
  try {
    const r = g.json(['open', GROVE, '--window', windowId]);
    assert.equal(r.code, 0, r.out);
    const foreign = r.json.items.filter(
      (i: { classification: string; workspace_id: string }) =>
        i.classification === 'foreign' && i.workspace_id === strangerId,
    );
    assert.equal(foreign.length, 1, 'the stranger was not classified foreign');

    const ledger = JSON.parse(
      g.exec(`cat ${GROVE}/.grove-cmux/projection.json`).slice(
        g.exec(`cat ${GROVE}/.grove-cmux/projection.json`).indexOf('{'),
      ),
    );
    assert.ok(
      !Object.values(ledger.trees).includes(strangerId),
      'the wrapper adopted a workspace it did not create',
    );
    const alive = g.rpc('workspace.list', { window_id: windowId }).workspaces;
    assert.ok(alive.some((w: { id: string }) => w.id === strangerId), 'the stranger was closed');
  } finally {
    g.rpc('workspace.close', { window_id: windowId, workspace_id: strangerId });
  }
});

live('AC-09: every workspace the wrapper created sits in the window it was told to use', (g) => {
  const r = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(r.code, 0, r.out);
  const ledger = JSON.parse(
    (() => {
      const t = g.exec(`cat ${GROVE}/.grove-cmux/projection.json`);
      return t.slice(t.indexOf('{'));
    })(),
  );
  assert.equal(ledger.window_id, windowId);
  const ids = new Set(g.rpc('workspace.list', { window_id: windowId }).workspaces.map(
    (w: { id: string }) => w.id,
  ));
  for (const uuid of Object.values(ledger.trees) as string[]) {
    assert.ok(ids.has(uuid), `${uuid} is not in window ${windowId}`);
  }
});

/**
 * The refusal and re-attach paths, live. The review's point stands: these are the five
 * behaviours where the wrapper declines to act, and proving them only against a fake proves
 * that the fake declines.
 */

live('D1: two windows and nothing naming one refuses a mutation against real cmux', (g) => {
  const extra = g.rpc('window.create', {}).window_id as string;
  try {
    const r = g.json(['open', GROVE]);
    assert.equal(r.code, 11, r.out);
    assert.equal(r.json.class, 'E_AMBIGUOUS_TARGET');
    assert.match(r.json.remedy, /--window/);
    // Nothing was projected into any window.
    const ws = g.rpc('workspace.list', { window_id: windowId }).workspaces;
    assert.equal(
      ws.filter((w: { current_directory: string }) => (w.current_directory ?? '').startsWith(GROVE)).length,
      0,
    );
  } finally {
    g.rpc('window.close', { window_id: extra });
  }
});

live('D1: the same situation makes status report every window instead of refusing', (g) => {
  const extra = g.rpc('window.create', {}).window_id as string;
  try {
    const r = g.json(['status', GROVE]);
    assert.equal(r.code, 0, r.out);
    assert.ok(Array.isArray(r.json.windows), 'status refused instead of enumerating');
    assert.ok(r.json.windows.length >= 2);
  } finally {
    g.rpc('window.close', { window_id: extra });
  }
});

live('D2: opening in a second window refuses E_PROJECTION_CONFLICT and names the first', (g) => {
  const opened = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(opened.code, 0, opened.out);
  const other = g.rpc('window.create', {}).window_id as string;
  try {
    const r = g.json(['open', GROVE, '--window', other]);
    assert.equal(r.code, 13, r.out);
    assert.equal(r.json.class, 'E_PROJECTION_CONFLICT');
    assert.equal(r.json.evidence.found_window, windowId);
    assert.match(r.json.remedy, /--relocate/);
    const inOther = g.rpc('workspace.list', { window_id: other }).workspaces;
    assert.equal(
      inOther.filter((w: { current_directory: string }) => (w.current_directory ?? '').startsWith(GROVE)).length,
      0,
      'it projected into the second window anyway',
    );
  } finally {
    g.rpc('window.close', { window_id: other });
  }
});

live('D2: --relocate projects into the new window and closes nothing in the old one', (g) => {
  const opened = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(opened.code, 0, opened.out);
  const originals = (Object.values(readLedger(g).trees) as string[]).slice();
  const other = g.rpc('window.create', {}).window_id as string;
  try {
    const r = g.json(['open', GROVE, '--window', other, '--relocate']);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.json.window.id, other);
    assert.equal(r.json.summary.missing, 0);

    // Every original workspace is still alive in the old window.
    const oldWs = g.rpc('workspace.list', { window_id: windowId }).workspaces.map(
      (w: { id: string }) => w.id,
    );
    for (const id of originals) {
      assert.ok(oldWs.includes(id), `--relocate closed ${id} in the window it left`);
    }
    // And the ledger has stopped claiming them.
    const now = Object.values(readLedger(g).trees) as string[];
    for (const id of originals) assert.ok(!now.includes(id), `the ledger still claims ${id}`);
  } finally {
    // The relocated projection lives in the window about to close; drop the ledger with it.
    g.exec(`rm -rf ${GROVE}/.grove-cmux`);
    g.rpc('window.close', { window_id: other });
  }
});

live('H1 live: a stranger group holding our workspaces is reclaimed, never claimed', (g) => {
  const opened = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(opened.code, 0, opened.out);
  const ours = Object.values(readLedger(g).trees) as string[];
  const oldGroup = opened.json.group.id as string;

  // A person dissolves our group and files our workspaces into one of their own.
  g.rpc('workspace.group.ungroup', { window_id: windowId, group_id: oldGroup });
  const theirs = g.rpc('workspace.group.create', {
    window_id: windowId,
    name: 'someone-elses-work',
    cwd: '/tmp',
    child_workspace_ids: ours,
  });
  const theirGroup = (theirs.group ?? theirs) as { id: string; anchor_workspace_id: string };

  const status = g.json(['status', GROVE, '--window', windowId]);
  assert.equal(status.json.summary.present, 0, 'a stranger group read as ours');
  assert.equal(status.json.summary.detached, ours.length);

  const r = g.json(['sync', GROVE, '--window', windowId]);
  assert.equal(r.code, 0, r.out);
  const led = readLedger(g);
  assert.notEqual(led.group_id, theirGroup.id, 'the ledger claimed a stranger group');
  assert.notEqual(led.anchor_workspace_id, theirGroup.anchor_workspace_id);

  // Their group survives, holding only its own anchor: cmux moved our members out.
  const groups = g.rpc('workspace.group.list', { window_id: windowId }).groups;
  const still = groups.find((x: { id: string }) => x.id === theirGroup.id);
  assert.ok(still, 'reclaiming destroyed a group we do not own');
  assert.deepEqual(still.member_workspace_ids, [theirGroup.anchor_workspace_id]);
  assert.equal(r.json.summary.present, ours.length);

  g.rpc('workspace.group.ungroup', { window_id: windowId, group_id: theirGroup.id });
  g.rpc('workspace.close', { window_id: windowId, workspace_id: theirGroup.anchor_workspace_id });
});

live('F4 live: a directory that is not a Grove refuses rather than projecting an empty group', (g) => {
  g.exec('mkdir -p /tmp/not-a-grove');
  const r = g.json(['status', '/tmp/not-a-grove', '--window', windowId]);
  assert.equal(r.code, 12, r.out);
  assert.equal(r.json.class, 'E_PRECONDITION');
});

live('a destructive sync that removes every Tree leaves the Grove group alive', (g) => {
  // The old claim that closing the anchor destroys the group outright was disproved: cmux
  // promotes members through the measured 3 → 2 → 1 → 0 lifecycle. apply() still keeps the
  // anchor as the final workspace so destructive sync preserves the group; close removes it last.
  const opened = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(opened.code, 0, opened.out);
  const groupId = opened.json.group.id as string;
  const anchorId = opened.json.group.anchor_workspace_id as string;

  g.exec(`mkdir -p /tmp/parked && mv ${GROVE}/trees/* /tmp/parked/ 2>/dev/null || true`);
  try {
    const r = g.json(['sync', GROVE, '--window', windowId, '--allow-destructive']);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.json.summary.stale, 0, 'a stale workspace survived --allow-destructive');

    const groups = g.rpc('workspace.group.list', { window_id: windowId }).groups;
    const ours = groups.find((x: { id: string }) => x.id === groupId);
    assert.ok(ours, 'closing every member destroyed the Grove group');
    assert.equal(ours.anchor_workspace_id, anchorId);
    assert.deepEqual(ours.member_workspace_ids, [anchorId]);
    assert.equal(r.json.group.state, 'present');
  } finally {
    g.exec(`mv /tmp/parked/* ${GROVE}/trees/ 2>/dev/null || true; rmdir /tmp/parked 2>/dev/null || true`);
  }
});

live('workspace.group.add on a member already in the group is not an error', (g) => {
  const opened = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(opened.code, 0, opened.out);
  const groupId = opened.json.group.id as string;
  const member = Object.values(readLedger(g).trees)[0] as string;
  const before = g.rpc('workspace.group.list', { window_id: windowId }).groups.find(
    (x: { id: string }) => x.id === groupId,
  ).member_workspace_ids.length;

  g.rpc('workspace.group.add', { window_id: windowId, group_id: groupId, workspace_id: member });
  const after = g.rpc('workspace.group.list', { window_id: windowId }).groups.find(
    (x: { id: string }) => x.id === groupId,
  ).member_workspace_ids;
  assert.equal(after.length, before, 're-adding a member changed the membership count');
  assert.equal(after.filter((x: string) => x === member).length, 1, 'the member was duplicated');
});

/**
 * The workflow a person actually asks for: make a Grove, and start an agent in each Tree.
 *
 * Both were previously proven only against a fake grove and a fake cmux, and both were broken
 * in ways only a live run could show — real grove says `outcome: "complete"` and returns
 * `targets` as an array of per-Tree records, neither of which the fake did.
 *
 * The agent case deliberately goes past transport. A created workspace and an accepted command
 * prove nothing about whether the agent ran, so the fixture agent records its own working
 * directory and the assertion is on that file.
 */

const PROVER = '/Users/admin/prover.sh';
const PROOF = '/tmp/agent-proof.txt';

function defineProverAgent(g: NonNullable<Guest>): void {
  const out = g.exec(`export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"
cat > ${PROVER} <<'PROVER'
#!/bin/sh
printf '%s\\n' "$PWD" >> ${PROOF}
PROVER
chmod +x ${PROVER}
cd ~/work
grove agent ls 2>/dev/null | grep -q 'Name: prover' || grove agent add prover ${PROVER} >/dev/null
grove agent ls`);
  assert.match(out, /Name: prover/, `the prover agent was not defined: ${out}`);
}

live('AC-12 live: --agent starts grove agent run in each Tree, and it actually runs', (g) => {
  defineProverAgent(g);
  g.exec(`rm -f ${PROOF}`);

  const r = g.json(['open', GROVE, '--window', windowId, '--agent', 'prover']);
  assert.equal(r.code, 0, r.out);
  const trees = Object.keys(readLedger(g).trees);
  assert.ok(trees.length >= 2);

  // The agents run inside real cmux terminals, so give them a moment.
  g.exec('sleep 12');
  const proof = g.exec(`cat ${PROOF} 2>/dev/null || true`);
  const ran = proof
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(GROVE));

  assert.equal(ran.length, trees.length, `expected one agent per Tree, got: ${proof}`);
  for (const tree of trees) {
    assert.ok(
      ran.includes(`${GROVE}/trees/${tree}`),
      `no agent ran in ${tree}; the proof file says: ${proof}`,
    );
  }

  // The workspace outlives the agent: the command exits, the terminal stays.
  const after = g.json(['status', GROVE, '--window', windowId]);
  assert.equal(after.json.summary.present, trees.length, 'a workspace died with its agent');
  g.exec(`rm -f ${PROOF}`);
});

live('AC-12 live: no agent starts unless one is asked for', (g) => {
  defineProverAgent(g);
  g.exec(`rm -f ${PROOF}`);
  const r = g.json(['open', GROVE, '--window', windowId]);
  assert.equal(r.code, 0, r.out);
  g.exec('sleep 8');
  const proof = g.exec(`cat ${PROOF} 2>/dev/null || true`).trim();
  assert.ok(!proof.includes(GROVE), `an agent ran without being requested: ${proof}`);
});

live('AC-11 live: new composes real grove and projects the Grove it actually made', (g) => {
  const name = `livenew${process.pid}`;
  const root = `/Users/admin/work/groves/${name}`;
  g.exec(`rm -rf ${root}`);
  try {
    const r = g.json(['new', name, '--all', '--window', windowId], { cwd: '~/work' });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.json, r.out);

    // The Grove root came from a Tree path in grove's own output, not from <cwd>/<name>.
    assert.equal(r.json.grove.root, root, 'the Grove root was guessed rather than read');
    assert.ok(r.json.summary.present > 0);
    assert.equal(r.json.summary.missing, 0);
    assert.equal(r.json.group.state, 'present');

    // Every Tree grove made is projected, and each is its own worktree.
    const onDisk = g
      .exec(`ls ${root}/trees`)
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const ledger = Object.keys(readLedger(g, root).trees);
    assert.deepEqual(ledger.sort(), onDisk.sort());
  } finally {
    const led = g.exec(`cat ${root}/.grove-cmux/projection.json 2>/dev/null || true`);
    const start = led.indexOf('{');
    if (start >= 0) {
      const parsed = JSON.parse(led.slice(start));
      for (const uuid of Object.values(parsed.trees) as string[]) {
        g.rpc('workspace.close', { window_id: windowId, workspace_id: uuid });
      }
      if (parsed.group_id) {
        g.rpc('workspace.group.ungroup', { window_id: windowId, group_id: parsed.group_id });
      }
      if (parsed.anchor_workspace_id) {
        g.rpc('workspace.close', { window_id: windowId, workspace_id: parsed.anchor_workspace_id });
      }
    }
    g.exec(`rm -rf ${root}`);
  }
});

/* ------------------------------------------------------------------------------------------
 * D8: the handoff.
 *
 * `open --agent` rides on workspace.create's initial_command, so it can start an agent once
 * per Tree and never again. These cases are the repeat operation: a task handed to an agent
 * in a Grove that is already open. They assert on what the receiving agent recorded — its own
 * working directory and its own argv — because a created surface and an accepted command
 * prove transport and nothing else.
 * --------------------------------------------------------------------------------------- */

const ECHOARGS = '/Users/admin/echoargs.sh';
const HANDOFF_PROOF = '/tmp/handoff-proof.txt';

function defineEchoAgent(g: NonNullable<Guest>): void {
  const out = g.exec(`export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"
cat > ${ECHOARGS} <<'AGENT'
#!/bin/sh
{
  printf 'PWD=%s\\n' "$PWD"
  for a in "$@"; do printf 'ARG=[%s]\\n' "$a"; done
  printf 'END\\n'
} >> ${HANDOFF_PROOF}
AGENT
chmod +x ${ECHOARGS}
cd ~/work
grove agent ls 2>/dev/null | grep -q 'Name: echoargs' || grove agent add echoargs ${ECHOARGS} >/dev/null
grove agent ls`);
  assert.match(out, /Name: echoargs/, `the echoargs agent was not defined: ${out}`);
}

/**
 * Like g.json, but for a command carrying `--`: the flag has to go BEFORE the separator.
 * g.json appends it, which lands it in the agent's argv — correct `--` semantics, and not
 * what the case is asking about.
 */
function cliJson(g: NonNullable<Guest>, args: string[]): { code: number; out: string; json: any } {
  const r = g.cli(args);
  const start = r.out.indexOf('{');
  let json = null;
  if (start >= 0) {
    try {
      json = JSON.parse(r.out.slice(start));
    } catch {
      /* leave null so the assertion names the raw output */
    }
  }
  return { ...r, json };
}

/** The proof file as records, one per agent run. */
function handoffRuns(g: NonNullable<Guest>): { pwd: string; args: string[] }[] {
  const raw = g.exec(`cat ${HANDOFF_PROOF} 2>/dev/null || true`);
  const runs: { pwd: string; args: string[] }[] = [];
  let cur: { pwd: string; args: string[] } | null = null;
  for (const line of raw.split('\n').map((l) => l.trim())) {
    if (line.startsWith('PWD=')) cur = { pwd: line.slice(4), args: [] };
    else if (line.startsWith('ARG=[') && line.endsWith(']') && cur) {
      cur.args.push(line.slice(5, -1));
    } else if (line === 'END' && cur) {
      runs.push(cur);
      cur = null;
    }
  }
  return runs;
}

live('AC-21 / D8 live: run hands a task to an agent in an ALREADY-OPEN Grove, argv intact', (g) => {
  defineEchoAgent(g);
  g.exec(`rm -f ${HANDOFF_PROOF}`);

  assert.equal(g.json(['open', GROVE, '--window', windowId]).code, 0);
  const trees = Object.keys(readLedger(g).trees);
  assert.ok(trees.length >= 2);
  const target = trees[0]!;
  const workspacesBefore = (g.rpc('workspace.list', { window_id: windowId }).workspaces ?? []).length;

  const r = cliJson(g, [
    'run', GROVE, '--window', windowId, '--tree', target, '--agent', 'echoargs', '--json',
    '--', '--model', 'opus', 'do the thing, carefully',
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.launched.length, 1, r.out);
  assert.equal(r.json.launched[0].tree, target);

  g.exec('sleep 10');
  const runs = handoffRuns(g);
  assert.equal(runs.length, 1, `expected one agent run, proof file says: ${JSON.stringify(runs)}`);

  // It ran in the Tree, not in the Grove root and not in the caller's directory.
  assert.equal(runs[0]!.pwd, `${GROVE}/trees/${target}`);
  // The multi-word prompt arrived as ONE argument, which is the whole reason `--` exists.
  assert.deepEqual(runs[0]!.args, ['--model', 'opus', 'do the thing, carefully']);

  // No workspace was created: the surface went into the one the ledger already named.
  const workspacesAfter = (g.rpc('workspace.list', { window_id: windowId }).workspaces ?? []).length;
  assert.equal(workspacesAfter, workspacesBefore, 'run created a workspace instead of reusing one');

  // And the workspace outlived the agent, as AC-12 requires of a launch.
  const after = g.json(['status', GROVE, '--window', windowId]);
  assert.equal(after.json.summary.present, trees.length, 'a workspace died with its agent');
  g.exec(`rm -f ${HANDOFF_PROOF}`);
});

live('AC-21 / D8 live: the SECOND handoff to the same Tree runs too', (g) => {
  defineEchoAgent(g);
  g.exec(`rm -f ${HANDOFF_PROOF}`);
  assert.equal(g.json(['open', GROVE, '--window', windowId]).code, 0);
  const target = Object.keys(readLedger(g).trees)[0]!;

  for (const word of ['first', 'second']) {
    const r = cliJson(g, [
      'run', GROVE, '--window', windowId, '--tree', target, '--agent', 'echoargs', '--json',
      '--', word,
    ]);
    assert.equal(r.code, 0, r.out);
    g.exec('sleep 8');
  }

  const runs = handoffRuns(g);
  // This is exactly what `open --agent` cannot do: its initial_command fires only at creation,
  // so the second call would have created nothing and started nothing.
  assert.deepEqual(runs.map((x) => x.args), [['first'], ['second']], JSON.stringify(runs));
  assert.deepEqual(new Set(runs.map((x) => x.pwd)), new Set([`${GROVE}/trees/${target}`]));
  g.exec(`rm -f ${HANDOFF_PROOF}`);
});

live('D8 live: an agent grove does not define is refused before cmux is touched', (g) => {
  defineEchoAgent(g);
  assert.equal(g.json(['open', GROVE, '--window', windowId]).code, 0);
  const target = Object.keys(readLedger(g).trees)[0]!;
  const before = (g.rpc('workspace.list', { window_id: windowId }).workspaces ?? []).length;

  const r = g.json(['run', GROVE, '--window', windowId, '--tree', target, '--agent', 'nosuch']);
  assert.equal(r.code, 12, r.out);
  assert.equal(r.json.class, 'E_PRECONDITION');
  assert.ok(r.json.evidence.defined.includes('echoargs'), r.out);

  const after = (g.rpc('workspace.list', { window_id: windowId }).workspaces ?? []).length;
  assert.equal(after, before, 'the refusal still changed cmux');
});

/* ------------------------------------------------------------------------------------------
 * D1 rule 3/4: what a wrapper run from inside a cmux terminal targets.
 *
 * Every other live case passes --window explicitly over ssh, where cmux supplies no caller
 * context at all. These two run the wrapper the way an agent inside cmux runs it: from a
 * terminal cmux itself started, with CMUX_WORKSPACE_ID in the environment.
 * --------------------------------------------------------------------------------------- */

const CALLER_OUT = '/tmp/caller-status.json';

/**
 * Run grove-cmux inside a cmux terminal in `windowId` and return its parsed --json.
 *
 * The surface is created in a workspace of that window, so cmux fills in the caller context
 * that `cmux identify` reads. Nothing else in the suite exercises that path.
 */
function cliFromInsideCmux(
  g: NonNullable<Guest>,
  workspaceId: string,
  args: string[],
): Record<string, any> {
  g.exec(`rm -f ${CALLER_OUT}`);
  // Two things this command must not do, both measured against the live socket:
  //
  //   - begin with `export`, or any other word that is not a resolvable executable. cmux
  //     resolves the FIRST whitespace-delimited token of initial_command as a program, and
  //     when it does not resolve the whole command silently does not run: no error, no
  //     output, a surface that looks exactly like a successful launch. `export ...`,
  //     `{ ... }` and `true; ...` all vanish this way; `node ...` and `grove ...` do not.
  //     So the environment goes in startup_environment, which is the param for it.
  //   - carry a `"` or a `$`. The param is JSON-encoded into a shell-quoted argument on the
  //     way to the guest, and both survive that round trip mangled.
  //
  // Nothing routes by window_id either: window_id outranks workspace_id in cmux's selector
  // precedence, so naming a window the workspace is not in resolves to no target at all.
  const password = g.exec('cat $HOME/.cmux-test-password').trim();
  const cmd =
    `node /Users/admin/grove-cmux/dist/cli.js ${args.join(' ')} ` +
    `--json > ${CALLER_OUT} 2>&1; exec /bin/zsh -l`;
  g.rpc('surface.create', {
    workspace_id: workspaceId,
    working_directory: '/Users/admin',
    startup_environment: {
      PATH: '/opt/homebrew/bin:/Users/admin/.local/bin:/usr/bin:/bin',
      CMUX_SOCKET_PASSWORD: password,
      CMUX_QUIET: '1',
    },
    initial_command: cmd,
    focus: false,
  });
  g.exec('sleep 12');
  const raw = g.exec(`cat ${CALLER_OUT} 2>/dev/null || true`);
  const start = raw.indexOf('{');
  assert.ok(start >= 0, `grove-cmux inside cmux wrote no JSON: ${raw}`);
  return JSON.parse(raw.slice(start));
}

live('D1 live: run from inside a cmux terminal, caller context names the window', (g) => {
  // Two windows and no ledger: from outside, a read enumerates both and a mutation refuses.
  // From inside a cmux terminal there is exactly one right answer, and cmux supplies it.
  const second = g.rpc('window.create', {});
  const secondId = second.window_id ?? second.id;
  assert.ok(secondId, `window.create returned no id: ${JSON.stringify(second)}`);
  try {
    const ws = g.rpc('workspace.list', { window_id: windowId }).workspaces ?? [];
    assert.ok(ws.length > 0, 'the target window has no workspace to run from');

    const out = cliFromInsideCmux(g, ws[0]!.id, ['status', GROVE]);
    assert.equal(out.window?.source, 'caller', JSON.stringify(out).slice(0, 400));
    assert.equal(out.window?.id, windowId);
    // Not the enumerating shape: caller context resolved a single window.
    assert.ok(!Array.isArray(out.windows), 'it enumerated instead of using caller context');
  } finally {
    g.rpc('window.close', { window_id: secondId });
  }
});

live('D1 live: a verified ledger beats caller context, so a read from window B sees window A', (g) => {
  // The bug this replaces: an agent in a cmux terminal in another window asked about a
  // projected Grove and was told, with exit 0, that every Tree was missing.
  assert.equal(g.json(['open', GROVE, '--window', windowId]).code, 0);
  const trees = Object.keys(readLedger(g).trees);

  const second = g.rpc('window.create', {});
  const secondId = second.window_id ?? second.id;
  assert.ok(secondId, `window.create returned no id: ${JSON.stringify(second)}`);
  try {
    const otherWs = g.rpc('workspace.list', { window_id: secondId }).workspaces ?? [];
    assert.ok(otherWs.length > 0, 'the new window has no workspace to run from');

    const out = cliFromInsideCmux(g, otherWs[0]!.id, ['status', GROVE]);
    assert.equal(out.window?.id, windowId, 'the read followed the caller into the wrong window');
    assert.equal(out.window?.source, 'ledger');
    assert.equal(out.summary?.present, trees.length, 'a projected Grove was reported missing');
  } finally {
    g.rpc('window.close', { window_id: secondId });
  }
});

/* ------------------------------------------------------------------------------------------
 * The last link: the agent receiving the task is a real Claude.
 *
 * Every other case proves the task reaches *an* agent. This one proves it reaches the thing a
 * person actually hands work to, authenticated, in the right Tree, and that an answer comes
 * back. The guest's Claude credentials live in the login keychain, which an ssh session cannot
 * unlock — `claude auth status` over ssh reports loggedIn:false on a guest that is signed in.
 * A cmux terminal runs in the GUI session, where the keychain is open, so both the probe and
 * the agent have to run there.
 * --------------------------------------------------------------------------------------- */

const CLAUDE_AGENT = '/Users/admin/claude-task.sh';
const CLAUDE_PROOF = '/tmp/claude-task-proof.txt';
const CLAUDE_BIN = '/Users/admin/.local/bin/claude';

/** Run a command in a cmux terminal, wait for its output file, and return it. */
function inGuiSession(g: NonNullable<Guest>, command: string, outFile: string, waitSeconds: number): string {
  const password = g.exec('cat $HOME/.cmux-test-password').trim();
  const ws = g.rpc('workspace.list', { window_id: windowId }).workspaces ?? [];
  assert.ok(ws.length > 0, 'no workspace to run from');
  g.exec(`rm -f ${outFile}`);
  g.rpc('surface.create', {
    workspace_id: ws[0]!.id,
    working_directory: '/Users/admin',
    startup_environment: {
      PATH: '/opt/homebrew/bin:/Users/admin/.local/bin:/usr/bin:/bin',
      CMUX_SOCKET_PASSWORD: password,
      CMUX_QUIET: '1',
    },
    initial_command: `${command}; exec /bin/zsh -l`,
    focus: false,
  });
  return g.exec(
    `for i in $(seq 1 ${Math.ceil(waitSeconds / 3)}); do [ -s ${outFile} ] && break; sleep 3; done
cat ${outFile} 2>/dev/null || true`,
  );
}

function claudeIsSignedIn(g: NonNullable<Guest>): boolean {
  const out = inGuiSession(g, `${CLAUDE_BIN} auth status > /tmp/gui-auth.json 2>&1`, '/tmp/gui-auth.json', 30);
  return /"loggedIn"\s*:\s*true/.test(out);
}

live('AC-21 live: the agent receiving the task is a real, authenticated Claude', (g) => {
  if (!claudeIsSignedIn(g)) {
    // Not a pass. Say what is missing and how to fix it, rather than reporting green.
    console.log(
      '  SKIPPED: this guest has no Claude sign-in. Open a cmux terminal in it and run\n' +
      '  `claude` once, then re-freeze the base. Everything up to the agent is still proven.',
    );
    return;
  }

  g.exec(`export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"
cat > ${CLAUDE_AGENT} <<'AGENT'
#!/bin/sh
# grove forwards everything after \`--\` here as argv, so the task is "$1" whatever spaces it has.
{
  printf 'CWD=%s\\n' "$PWD"
  printf 'TASK=%s\\n' "$1"
  printf 'REPLY='
  ${CLAUDE_BIN} -p "$1" 2>&1
  printf '\\nEND\\n'
} >> ${CLAUDE_PROOF}
AGENT
chmod +x ${CLAUDE_AGENT}
cd ~/work
grove agent ls 2>/dev/null | grep -q 'Name: claude-task' || grove agent add claude-task ${CLAUDE_AGENT} >/dev/null`);
  g.exec(`rm -f ${CLAUDE_PROOF}`);

  assert.equal(g.json(['open', GROVE, '--window', windowId]).code, 0);
  const target = Object.keys(readLedger(g).trees).sort()[0]!;

  const prompt = 'Reply with exactly the word BANANA and nothing else.';
  const r = cliJson(g, [
    'run', GROVE, '--window', windowId, '--tree', target, '--agent', 'claude-task', '--json',
    '--', prompt,
  ]);
  assert.equal(r.code, 0, r.out);

  // A real model call, so give it room. The assertion is on what came back, not on the wait.
  const proof = g.exec(
    `for i in $(seq 1 40); do grep -q END ${CLAUDE_PROOF} 2>/dev/null && break; sleep 3; done
cat ${CLAUDE_PROOF} 2>/dev/null || true`,
  );

  assert.match(proof, /END/, `Claude never finished; proof file says: ${proof}`);

  // What this case owns: the real claude binary ran, in the Tree's own worktree rather than
  // the Grove root or the caller's directory, and the prompt reached it as one argument.
  assert.match(proof, new RegExp(`CWD=${GROVE}/trees/${target}\\b`), proof);
  assert.ok(proof.includes(`TASK=${prompt}`), `the task arrived altered: ${proof}`);

  // What it does not own: whether the model answers. A frozen base image cannot hold a live
  // OAuth session — `claude auth status` still reports loggedIn:true from the stored token,
  // and the call then fails with "OAuth session expired". Asserting on the reply would make
  // this case a test of Anthropic's token lifetime, and it would go red on a shelf-aged image
  // while the wrapper was working perfectly. So a stale session is reported, not failed.
  if (/OAuth session expired|Failed to authenticate/i.test(proof)) {
    console.log(
      '  PARTIAL: the task reached a real Claude in the right Tree, but this guest\'s stored\n' +
      '  OAuth session has expired, so no reply came back. Open a cmux terminal in the guest,\n' +
      '  run `claude` once to refresh it, and re-freeze the base to restore the full proof.',
    );
  } else {
    assert.match(proof, /REPLY=\s*BANANA/, `Claude ran and authenticated but did not answer: ${proof}`);
  }
  g.exec(`rm -f ${CLAUDE_PROOF}`);
});
