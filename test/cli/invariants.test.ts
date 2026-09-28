/**
 * The invariant, tested at the executor rather than at the planner.
 *
 * `classify()` obeys the capability rule strictly, and its tests prove it. The executor is
 * where it broke: the ledger was authoritative when the planner read it and optional when the
 * executor wrote it. These are the property tests that catch that class, plus a regression for
 * each defect a review found in this file's absence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, run, runJson } from '../helpers/world.mjs';

const MUTATING = new Set([
  'workspace.create',
  'workspace.close',
  'workspace.group.create',
  'workspace.group.add',
  'workspace.group.ungroup',
  // Branding is a mutation like any other, so it is inside the capability rule rather than
  // beside it. A call that only changes a colour still names an id, and an id it may not name
  // is exactly the defect this file exists to catch.
  'workspace.group.set_icon',
  'workspace.group.set_color',
  'set-status',
]);

/**
 * Every id a mutating call names must be one the ledger holds, or one this run created, or
 * the window. Nothing else is ever a legitimate target.
 */
class CapabilityWatcher {
  cursor = 0;
  /**
   * Ids that have ever been ours, seeded ONLY from the ledger as it stood before a run and
   * from objects cmux created during one.
   *
   * The first version of this seeded from `current_directory.startsWith(root)` and from the
   * ledger as it stood *after* the run. Both were wrong, and wrong in the two ways the design
   * exists to prevent. The path clause granted ownership on position, which is the evidence
   * D4 forbids, so a `workspace.close` on a stranger who had merely cd'd into a Tree passed
   * the rule. And reading the ledger afterwards let a run become compliant by the act of
   * claiming, since the run under test is the thing editing that file.
   */
  readonly permitted = new Set<string>();
  readonly world: ReturnType<typeof makeWorld>;

  constructor(world: ReturnType<typeof makeWorld>) {
    this.world = world;
    this.seedFromLedger();
    this.cursor = world.state().calls.length;
  }

  /** Call before each command, so "before the run" means before that command. */
  private seedFromLedger() {
    const ledger = this.world.ledger();
    if (!ledger) return;
    for (const uuid of Object.values(ledger.trees) as string[]) this.permitted.add(uuid);
    if (ledger.group_id) this.permitted.add(ledger.group_id);
    if (ledger.anchor_workspace_id) this.permitted.add(ledger.anchor_workspace_id);
  }

  check(note: string) {
    const state = this.world.state();
    for (const w of state.windows as Array<{ id: string }>) this.permitted.add(w.id);

    const calls = (
      state.calls as Array<{ method: string; params: Record<string, string>; created?: string[] }>
    ).slice(this.cursor);
    this.cursor = state.calls.length;

    // Only ids cmux actually returned to a create this run issued. A workspace that merely
    // appeared could have been made by a person, and blessing it would be inference again.
    for (const c of calls) {
      for (const id of c.created ?? []) this.permitted.add(id);
    }
    assertCallsPermitted(calls, this.permitted, note);

    // The watcher inspects calls, so a run that merely *records* a stranger's id without
    // mutating it would pass, and the next run's mutations on it would then be permitted
    // because the ledger names it. Close that by checking what the run wrote, not only what
    // it called: any id newly in the ledger must have been permitted before, or created here.
    const ledger = this.world.ledger();
    if (ledger) {
      const written: Array<[string, string]> = [
        ...(Object.entries(ledger.trees) as Array<[string, string]>),
        ...(ledger.group_id ? ([['group_id', ledger.group_id]] as Array<[string, string]>) : []),
        ...(ledger.anchor_workspace_id
          ? ([['anchor_workspace_id', ledger.anchor_workspace_id]] as Array<[string, string]>)
          : []),
      ];
      for (const [field, id] of written) {
        assert.ok(
          this.permitted.has(id),
          `${note}: the ledger now claims ${field}=${id}, which was neither ours before this run nor created by it`,
        );
      }
    }

    // Only now does the ledger this run wrote count, for the *next* run.
    this.seedFromLedger();
  }
}

function assertCallsPermitted(
  calls: Array<{ method: string; params: Record<string, string> }>,
  permitted: Set<string>,
  note: string,
) {
  for (const c of calls) {
    if (!MUTATING.has(c.method)) continue;
    for (const key of ['workspace_id', 'group_id']) {
      const id = c.params[key];
      if (!id) continue;
      assert.ok(
        permitted.has(id),
        `${note}: ${c.method} named ${key}=${id}, which is neither in the ledger nor created by this run`,
      );
    }
    for (const id of (c.params.child_workspace_ids as unknown as string[]) ?? []) {
      assert.ok(permitted.has(id), `${note}: group.create adopted ${id}, which is not ours`);
    }
  }
}

/** One-shot form, for a world that runs a single command. */
function assertCapabilityRule(world: ReturnType<typeof makeWorld>, note: string) {
  new CapabilityWatcher(world).check(note);
}

/** After any successful run the ledger must describe the objects that exist. */
function assertLedgerPostcondition(world: ReturnType<typeof makeWorld>, note: string) {
  const ledger = world.ledger();
  assert.ok(ledger, `${note}: no ledger after a successful run`);
  const state = world.state();
  assert.ok(ledger.group_id, `${note}: the ledger names no group`);
  assert.ok(state.groups[ledger.group_id], `${note}: the ledger names a group that does not exist`);
  assert.ok(
    ledger.anchor_workspace_id && state.workspaces[ledger.anchor_workspace_id],
    `${note}: the ledger names an anchor that does not exist`,
  );
  assert.equal(
    state.groups[ledger.group_id].anchor_workspace_id,
    ledger.anchor_workspace_id,
    `${note}: the ledger's anchor is not that group's anchor`,
  );
  for (const [tree, uuid] of Object.entries(ledger.trees) as Array<[string, string]>) {
    assert.ok(state.workspaces[uuid], `${note}: the ledger names ${tree}=${uuid}, which does not exist`);
  }
}

/** A successful close retains provenance while releasing every cmux ownership field. */
function assertCloseLedgerPostcondition(world: ReturnType<typeof makeWorld>, note: string) {
  const ledger = world.ledger();
  assert.ok(ledger, `${note}: no retained ledger after close`);
  assert.deepEqual(ledger.trees, {}, `${note}: close retained Tree ownership`);
  assert.equal(ledger.group_id, null, `${note}: close retained group ownership`);
  assert.equal(ledger.anchor_workspace_id, null, `${note}: close retained anchor ownership`);
  assert.equal(ledger.window_id, null, `${note}: close retained a window hint`);
}

test('AC-25: the capability rule and ledger post-conditions hold through create and close', () => {
  const w = makeWorld({ trees: ['api', 'web', 'docs'] });
  try {
    const watch = new CapabilityWatcher(w);
    run(w, ['open', w.root]);
    watch.check('after open');
    assertLedgerPostcondition(w, 'after open');

    // A person dissolves the group; sync makes a new one and re-attaches by UUID.
    w.setState((s) => { s.groups = {}; });
    run(w, ['sync', w.root]);
    watch.check('after an ungroup and sync');
    assertLedgerPostcondition(w, 'after an ungroup and sync');

    // A Tree goes; the destructive path runs.
    w.removeTree(`${w.grove}@docs`);
    run(w, ['sync', w.root, '--allow-destructive']);
    watch.check('after a destructive sync');
    assertLedgerPostcondition(w, 'after a destructive sync');
    assert.equal(Object.keys(w.ledger()!.trees).length, 2);

    run(w, ['close', w.root]);
    watch.check('after close');
    assertCloseLedgerPostcondition(w, 'after close');
  } finally {
    w.cleanup();
  }
});

test('the capability rule holds with a stranger group and a stranger workspace present', () => {
  const w = makeWorld();
  try {
    w.setState((s) => {
      s.workspaces.strangerAnchor = { id: 'strangerAnchor', window_id: 'W1', title: 'scratch', current_directory: '/x' };
      s.workspaces.strangerMember = { id: 'strangerMember', window_id: 'W1', title: 'notes', current_directory: `${w.root}/trees/${w.grove}@api` };
      s.groups.GSTRANGE = {
        id: 'GSTRANGE', window_id: 'W1', name: 'scratch',
        anchor_workspace_id: 'strangerAnchor', member_workspace_ids: ['strangerAnchor', 'strangerMember'],
      };
    });
    const watch = new CapabilityWatcher(w);
    run(w, ['open', w.root]);
    watch.check('with a stranger group present, after open');
    run(w, ['sync', w.root, '--allow-destructive']);
    watch.check('with a stranger group present, after a destructive sync');
    // The stranger's group is untouched, members and all.
    const g = w.state().groups.GSTRANGE;
    assert.deepEqual(g.member_workspace_ids, ['strangerAnchor', 'strangerMember']);
  } finally {
    w.cleanup();
  }
});

test('F1: a partial projection is not re-projected into a second window', () => {
  const w = makeWorld({ trees: ['api', 'web', 'docs'] });
  try {
    // A ledger with Tree UUIDs and no group is exactly what a mid-run failure leaves.
    const failed = run(w, ['open', w.root, '--window', 'W1'], { FAKE_CMUX_FAIL_AFTER: '1' });
    assert.notEqual(failed.code, 0);
    const stranded = w.ledger()!;
    assert.equal(stranded.group_id, null, 'the fixture no longer produces a group-less ledger');
    assert.equal(Object.keys(stranded.trees).length, 1);

    w.setState((s) => { s.windows.push({ id: 'W2', title: 'second' }); });
    const r = runJson(w, ['open', w.root, '--window', 'W2']);
    assert.equal(r.code, 13, 'a partial projection was duplicated into a second window');
    assert.equal(r.json.class, 'E_PROJECTION_CONFLICT');
    assert.equal(r.json.evidence.found_window, 'W1');
    const inW2 = (Object.values(w.state().workspaces) as Array<Record<string, string>>)
      .filter((x) => x.window_id === 'W2');
    assert.deepEqual(inW2, []);
    // The stranded workspace is still the ledger's, not orphaned by a rewrite.
    assert.deepEqual(w.ledger()!.trees, stranded.trees);
  } finally {
    w.cleanup();
  }
});

test('F1: --relocate is still the way out, and the old window keeps its workspace', () => {
  const w = makeWorld({ trees: ['api', 'web', 'docs'] });
  try {
    run(w, ['open', w.root, '--window', 'W1'], { FAKE_CMUX_FAIL_AFTER: '1' });
    const strandedId = Object.values(w.ledger()!.trees)[0] as string;
    w.setState((s) => { s.windows.push({ id: 'W2' }); });

    const r = runJson(w, ['open', w.root, '--window', 'W2', '--relocate']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(w.state().workspaces[strandedId], '--relocate closed something in the old window');
    assert.equal(w.ledger()!.window_id, 'W2');
    // Post-condition: nothing from the old window is still claimed as ours.
    assert.ok(!Object.values(w.ledger()!.trees).includes(strandedId));
    assertLedgerPostcondition(w, 'after --relocate');
  } finally {
    w.cleanup();
  }
});

test('H1: no run can claim a group the ledger has no evidence for, even by writing', () => {
  const w = makeWorld();
  try {
    const watch = new CapabilityWatcher(w);
    run(w, ['open', w.root]);
    watch.check('after open');
    const ours = Object.values(w.ledger()!.trees) as string[];

    // The state that used to let --anchor claim by writing rather than by calling: our
    // workspaces sit in a stranger's group, so every Tree reads present and there is nothing
    // to attach. A run that recorded that group would issue zero mutating calls and the next
    // run's mutations on it would then be permitted, because the ledger named it.
    w.setState((s) => {
      s.groups = {};
      s.workspaces.theirAnchor = {
        id: 'theirAnchor', window_id: 'W1', title: 'theirs', current_directory: '/x',
      };
      s.groups.GTHEIRS = {
        id: 'GTHEIRS', window_id: 'W1', name: 'theirs',
        anchor_workspace_id: 'theirAnchor', member_workspace_ids: ['theirAnchor', ...ours],
      };
    });
    const r = runJson(w, ['sync', w.root]);
    assert.equal(r.code, 0, r.stderr);
    watch.check('after a sync while our workspaces sit in a stranger group');

    const led = w.ledger()!;
    assert.notEqual(led.group_id, 'GTHEIRS', 'the ledger claimed a stranger group');
    assert.notEqual(led.anchor_workspace_id, 'theirAnchor');
    // Their group keeps its own anchor and loses only what was ours.
    assert.deepEqual(w.state().groups.GTHEIRS.member_workspace_ids, ['theirAnchor']);
    assertLedgerPostcondition(w, 'after reclaiming from a stranger group');
  } finally {
    w.cleanup();
  }
});

test('F2: a ledger naming no group makes its own rather than adopting the one it sits in', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const gid = Object.keys(w.state().groups)[0]!;
    // The state the old executor left: Tree UUIDs recorded, no group.
    const led = w.ledger()!;
    writeFileSync(
      join(w.root, '.grove-cmux', 'projection.json'),
      JSON.stringify({ ...led, group_id: null, anchor_workspace_id: null }, null, 2),
    );
    const r = runJson(w, ['sync', w.root]);
    assert.equal(r.code, 0, r.stderr);
    // A group with no ledger evidence is not ours, whoever is sitting in it. Sync makes one.
    assert.notEqual(w.ledger()!.group_id, gid, 'ownership was inferred from where our workspaces sat');
    // And it records what it made, so the next run needs no inference either.
    assertLedgerPostcondition(w, 'after making its own group');
    assert.equal(r.json.summary.present, 2);
  } finally {
    w.cleanup();
  }
});

test('F3: the anchor the ledger records is never reported foreign', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const led = w.ledger()!;
    const anchorId = led.anchor_workspace_id as string;
    const treeIds = Object.values(led.trees) as string[];

    // A person dissolves our group and puts our two workspaces in a group of their own.
    w.setState((s) => {
      s.groups = {
        GNEW: {
          id: 'GNEW', window_id: 'W1', name: 'mine now',
          anchor_workspace_id: treeIds[0]!, member_workspace_ids: treeIds,
        },
      };
    });
    const r = runJson(w, ['status', w.root]);
    assert.equal(r.code, 0, r.stderr);
    const anchorItem = r.json.items.find((i: { workspace_id: string }) => i.workspace_id === anchorId);
    assert.ok(
      anchorItem === undefined || anchorItem.classification !== 'foreign',
      'the ledger reported its own anchor as foreign, not in ledger',
    );
  } finally {
    w.cleanup();
  }
});

test('F4: a directory that is not a Grove refuses instead of projecting an empty group', () => {
  const w = makeWorld();
  try {
    const notAGrove = join(w.base, 'just-a-folder');
    mkdirSync(notAGrove, { recursive: true });
    const r = runJson(w, ['open', notAGrove]);
    assert.equal(r.code, 12);
    assert.equal(r.json.class, 'E_PRECONDITION');
    assert.match(r.json.message, /is not a Grove/);
    assert.equal(Object.keys(w.state().groups).length, 0);
  } finally {
    w.cleanup();
  }
});

test('F4: a directory under trees/ that is not named <grove>@<repo> is not projected', () => {
  const w = makeWorld();
  try {
    mkdirSync(join(w.root, 'trees', 'scratch-notes'), { recursive: true });
    const r = runJson(w, ['open', w.root]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.summary.present, 2, 'a scratch directory was projected as a Tree');
    assert.ok(!Object.keys(w.ledger()!.trees).includes('scratch-notes'));
    assert.ok(r.json.warnings.some((x: string) => /scratch-notes/.test(x)), 'the skip was silent');
  } finally {
    w.cleanup();
  }
});

test('F5: open refuses --allow-destructive rather than accepting and ignoring it', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['open', w.root, '--allow-destructive']);
    assert.equal(r.code, 2);
    assert.equal(r.json.class, 'E_USAGE');
    assert.match(r.json.remedy, /grove-cmux sync --allow-destructive/);
  } finally {
    w.cleanup();
  }
});

test('F5: the stale warning is keyed on what the run did, not on the flag', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    w.removeTree(`${w.grove}@web`);
    // A sync that could have closed it but was not asked to must say so.
    const r = runJson(w, ['sync', w.root]);
    assert.ok(r.json.warnings.some((x: string) => /allow-destructive/.test(x)));
    // And one that did close it must not claim anything is still open.
    const d = runJson(w, ['sync', w.root, '--allow-destructive']);
    assert.equal(d.json.warnings.filter((x: string) => /left open/.test(x)).length, 0);
  } finally {
    w.cleanup();
  }
});

test('F6: the executed actions carry the reason the plan gave them', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    w.setState((s) => { s.groups = {}; });
    const r = runJson(w, ['sync', w.root]);
    assert.equal(r.code, 0, r.stderr);
    const created = r.json.applied.find((a: { op: string }) => a.op === 'group.create');
    assert.ok(created, 'no group was recreated after the ungroup');
    assert.equal(created.reason, 'not_in_group', 'the executed reason disagrees with the plan');
  } finally {
    w.cleanup();
  }
});

test('AC-02: the read-only guard sees every call, not only the ones going through rpc', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    w.setState((s) => { s.calls = []; });
    const r = runJson(w, ['status', w.root]);
    assert.equal(r.code, 0, r.stderr);
    const methods = (w.state().calls as Array<{ method: string }>).map((c) => c.method);
    // version, capabilities and list-windows all happen on the read path; if the journal did
    // not see them, a mutation written the same way would pass the guard unseen.
    assert.ok(methods.includes('version'));
    assert.ok(methods.includes('list-windows'));
  } finally {
    w.cleanup();
  }
});

test('a ledger naming a workspace at an unrelated path is still ours, and is not re-created', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const before = Object.keys(w.state().workspaces).length;
    w.setState((s) => {
      for (const ws of Object.values(s.workspaces) as Array<Record<string, string>>) {
        if (ws.title === 'api') ws.current_directory = '/completely/elsewhere';
      }
    });
    const r = runJson(w, ['sync', w.root]);
    assert.equal(r.json.summary.present, 2);
    assert.equal(Object.keys(w.state().workspaces).length, before);
  } finally {
    w.cleanup();
  }
});

test('a temp file is never left beside the ledger, even when a run fails', () => {
  const w = makeWorld({ trees: ['api', 'web', 'docs'] });
  try {
    run(w, ['open', w.root], { FAKE_CMUX_FAIL_AFTER: '1' });
    const entries = readdirSync(join(w.root, '.grove-cmux'));
    assert.deepEqual(entries, ['projection.json']);
  } finally {
    w.cleanup();
  }
});

test('a ledger directory that cannot be written refuses E_LEDGER rather than half-projecting', () => {
  const w = makeWorld();
  try {
    const dir = join(w.root, '.grove-cmux');
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, 'projection.json'), { force: true });
    writeFileSync(join(dir, 'projection.json'), '{ not json at all');
    const r = runJson(w, ['open', w.root]);
    assert.equal(r.code, 10);
    assert.equal(r.json.class, 'E_LEDGER');
    assert.equal(Object.keys(w.state().workspaces).length, 0, 'it projected on an unreadable ledger');
  } finally {
    w.cleanup();
  }
});

test('G1: sync never grows or claims a group the ledger does not name', () => {
  const w = makeWorld();
  try {
    const watch = new CapabilityWatcher(w);
    run(w, ['open', w.root]);
    watch.check('after open');
    const ours = Object.values(w.ledger()!.trees) as string[];

    // A person dissolves our group and drags both our workspaces into a group of their own,
    // whose anchor is a workspace of theirs at an unrelated path.
    w.setState((s) => {
      s.groups = {};
      s.workspaces.theirAnchor = {
        id: 'theirAnchor', window_id: 'W1', title: 'their work', current_directory: '/elsewhere',
      };
      s.groups.GTHEIRS = {
        id: 'GTHEIRS', window_id: 'W1', name: 'theirs',
        anchor_workspace_id: 'theirAnchor',
        member_workspace_ids: ['theirAnchor', ...ours],
      };
    });
    const before = w.state().groups.GTHEIRS.member_workspace_ids.length;

    // A new Tree appears, so sync has something to do.
    mkdirSync(join(w.root, 'trees', `${w.grove}@docs`), { recursive: true });
    const r = runJson(w, ['sync', w.root]);
    assert.equal(r.code, 0, r.stderr);
    watch.check('after a sync while our workspaces sit in a stranger group');

    const after = w.state().groups.GTHEIRS;
    assert.equal(
      after.member_workspace_ids.length,
      before - ours.length,
      'sync grew or shrank a stranger group by something other than reclaiming its own',
    );
    const led = w.ledger()!;
    assert.notEqual(led.group_id, 'GTHEIRS', 'the ledger claimed a stranger group');
    assert.notEqual(
      led.anchor_workspace_id,
      'theirAnchor',
      "the ledger claimed a stranger's workspace as this Grove's anchor",
    );
    assertLedgerPostcondition(w, 'after reclaiming from a stranger group');
  } finally {
    w.cleanup();
  }
});

test('G2: a stranger who merely cd-ed into a Tree is not permitted by the capability rule', () => {
  const w = makeWorld();
  try {
    const watch = new CapabilityWatcher(w);
    run(w, ['open', w.root]);
    watch.check('after open');
    // Position must never confer permission, so the watcher must not admit this id.
    w.setState((s) => {
      s.workspaces.squatter = {
        id: 'squatter', window_id: 'W1', title: 'theirs',
        current_directory: `${w.treePaths[`${w.grove}@api`]}/src`,
      };
    });
    // The watcher sees the new workspace, but it was created by cmux outside any run of ours;
    // admitCreations only runs at a check, so drive one and then assert the id is not blessed.
    run(w, ['status', w.root]);
    watch.check('after a stranger appeared inside a Tree');
    assert.ok(
      !watch.permitted.has('squatter'),
      'the capability rule granted permission on position, which D4 forbids',
    );
  } finally {
    w.cleanup();
  }
});

test('the orphan case: cmux created it, the ledger never learned its id, and it is not adopted', () => {
  const w = makeWorld();
  try {
    // The process dies after cmux applied the create and before the ledger write. This is the
    // collision between D4 and crash recovery that the incremental write was chosen to
    // narrow, and until now every partial state the suite could build was one where cmux and
    // the ledger already agreed.
    const died = run(w, ['open', w.root], { FAKE_CMUX_FAIL_AFTER_APPLYING: '0' });
    assert.notEqual(died.code, 0);

    const orphans = (Object.values(w.state().workspaces) as Array<Record<string, string>>)
      .filter((x) => (x.current_directory ?? '').startsWith(w.root));
    assert.equal(orphans.length, 1, 'the fixture no longer produces exactly one orphan');
    const orphanId = orphans[0]!.id;
    const ledger = w.ledger();
    assert.ok(
      ledger === null || !Object.values(ledger.trees).includes(orphanId),
      'the fixture did not actually strand the id',
    );

    // The next run must classify it foreign and must not adopt it, however exactly it sits on
    // the Tree path it was created at.
    const watch = new CapabilityWatcher(w);
    const r = runJson(w, ['open', w.root]);
    assert.equal(r.code, 0, r.stderr);
    watch.check('after recovering from an orphan');

    const item = r.json.items.find((i: { workspace_id: string }) => i.workspace_id === orphanId);
    assert.ok(item, 'the orphan was not reported at all');
    assert.equal(item.classification, 'foreign');
    assert.equal(item.owned, false);
    assert.ok(!Object.values(w.ledger()!.trees).includes(orphanId), 'the orphan was adopted');
    // It is left alone, not closed, and the Tree gets its own workspace.
    assert.ok(w.state().workspaces[orphanId], 'the orphan was closed');
    assert.equal(r.json.summary.present, 2);
    assertLedgerPostcondition(w, 'after recovering from an orphan');
  } finally {
    w.cleanup();
  }
});
