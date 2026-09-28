/**
 * End-to-end through the built binary, against a fake cmux that reproduces the properties
 * the live evidence established. Every case here has a live counterpart in test/live.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { makeWorld, run, runJson } from '../helpers/world.mjs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

test('AC-01: help and version work with no cmux at all', () => {
  const w = makeWorld();
  try {
    w.setState((s) => { s.running = false; });
    for (const args of [['--help'], ['open', '--help'], ['sync', '--help'], ['status', '--help'], ['new', '--help']]) {
      const r = run(w, args);
      assert.equal(r.code, 0, `${args.join(' ')} exited ${r.code}`);
      assert.ok(r.stdout.length > 40);
    }
    assert.equal(run(w, ['--version']).stdout.trim(), PACKAGE_VERSION);
  } finally {
    w.cleanup();
  }
});

test('AC-03: a clean two-Tree Grove opens as one group, one anchor, one member per Tree', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['open', w.root]);
    assert.equal(r.code, 0, r.stderr);
    const state = w.state();
    const groups = Object.values(state.groups) as Array<Record<string, unknown>>;
    assert.equal(groups.length, 1);
    // cmux counts the anchor as a member of its own group, so two Trees make three members.
    assert.equal((groups[0]!.member_workspace_ids as string[]).length, 3);
    assert.ok((groups[0]!.member_workspace_ids as string[]).includes(groups[0]!.anchor_workspace_id as string));

    const anchor = state.workspaces[groups[0]!.anchor_workspace_id as string];
    assert.equal(anchor.current_directory, w.root);

    // Each member sits at its own Tree, with the short title, not the full directory name.
    const members = (groups[0]!.member_workspace_ids as string[])
      .filter((id) => id !== groups[0]!.anchor_workspace_id)
      .map((id) => state.workspaces[id]);
    assert.deepEqual(members.map((m) => m.current_directory).sort(), Object.values(w.treePaths).sort());
    assert.deepEqual(members.map((m) => m.title).sort(), ['api', 'web']);

    const ledger = w.ledger()!;
    assert.equal(ledger.group_id, groups[0]!.id);
    assert.deepEqual(Object.keys(ledger.trees).sort(), w.treeNames.sort());
  } finally {
    w.cleanup();
  }
});

test('AC-04: open is idempotent — the second run creates nothing', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const before = w.state();
    const r = runJson(w, ['open', w.root]);
    assert.equal(r.code, 0, r.stderr);
    const after = w.state();
    assert.deepEqual(Object.keys(after.workspaces).sort(), Object.keys(before.workspaces).sort());
    assert.deepEqual(Object.keys(after.groups), Object.keys(before.groups));
    assert.deepEqual(r.json.applied, []);
    assert.equal(r.json.summary.present, 2);
  } finally {
    w.cleanup();
  }
});

test('AC-05: a Tree added through Grove creates exactly one member and touches nothing else', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const before = w.state();
    const beforeIds = Object.keys(before.workspaces);

    const w2 = makeWorld({ grove: w.grove, trees: ['docs'] });
    // Graft the new Tree into the existing Grove.
    cpSync(w2.treePaths[`${w.grove}@docs`], `${w.root}/trees/${w.grove}@docs`, { recursive: true });
    w2.cleanup();

    const r = runJson(w, ['sync', w.root]);
    assert.equal(r.code, 0, r.stderr);
    const after = w.state();
    const added = Object.keys(after.workspaces).filter((id) => !beforeIds.includes(id));
    assert.equal(added.length, 1);
    assert.equal(after.workspaces[added[0]!].title, 'docs');
    assert.deepEqual(Object.keys(after.groups), Object.keys(before.groups));
  } finally {
    w.cleanup();
  }
});

test('AC-06: a removed Tree is stale by default, and only --allow-destructive closes it', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    w.removeTree(`${w.grove}@web`);

    const additive = runJson(w, ['sync', w.root]);
    assert.equal(additive.code, 0, additive.stderr);
    assert.equal(additive.json.summary.stale, 1);
    assert.equal(Object.keys(w.state().workspaces).length, 3, 'nothing was closed');
    assert.ok(additive.json.warnings.some((x: string) => /allow-destructive/.test(x)));

    const destructive = runJson(w, ['sync', w.root, '--allow-destructive']);
    assert.equal(destructive.code, 0, destructive.stderr);
    assert.equal(Object.keys(w.state().workspaces).length, 2);
    assert.deepEqual(Object.keys(w.ledger()!.trees), [`${w.grove}@api`]);
  } finally {
    w.cleanup();
  }
});

test('AC-07: an empty Grove opens as an anchor-only group', () => {
  const w = makeWorld({ trees: [] });
  try {
    const r = runJson(w, ['open', w.root]);
    assert.equal(r.code, 0, r.stderr);
    const groups = Object.values(w.state().groups) as Array<Record<string, unknown>>;
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]!.member_workspace_ids, [groups[0]!.anchor_workspace_id]);
  } finally {
    w.cleanup();
  }
});

test('AC-02: status issues no mutating call, and exits 0 on findings', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    w.removeTree(`${w.grove}@web`);
    w.setState((s) => { s.calls = []; });

    const r = runJson(w, ['status', w.root]);
    assert.equal(r.code, 0, 'a finding is not a failure');
    assert.equal(r.json.summary.stale, 1);
    const mutating = w.state().calls.filter((c: { method: string }) =>
      c.method.startsWith('workspace.create') ||
      c.method.startsWith('workspace.close') ||
      c.method.startsWith('workspace.group.create') ||
      c.method.startsWith('workspace.group.add'),
    );
    assert.deepEqual(mutating, []);
  } finally {
    w.cleanup();
  }
});

test('S7.7: after an ungroup, sync re-attaches by UUID rather than duplicating', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const before = w.state();
    const gid = Object.keys(before.groups)[0]!;
    const beforeWorkspaces = Object.keys(before.workspaces).length;

    // The person dissolves the group. Every workspace survives, belonging to nothing.
    w.setState((s) => { delete s.groups[gid]; });

    const status = runJson(w, ['status', w.root]);
    assert.equal(status.json.summary.detached, 2);
    assert.equal(status.json.group.state, 'dissolved');

    const r = runJson(w, ['sync', w.root]);
    assert.equal(r.code, 0, r.stderr);
    const after = w.state();
    // One new anchor for the new group. No duplicate Tree workspaces.
    assert.equal(Object.keys(after.workspaces).length, beforeWorkspaces + 1);
    const groups = Object.values(after.groups) as Array<Record<string, unknown>>;
    assert.equal(groups.length, 1);
    assert.equal((groups[0]!.member_workspace_ids as string[]).length, 3);
    // The re-attached members are the same UUIDs, which is the whole point.
    const ledger = w.ledger()!;
    for (const uuid of Object.values(ledger.trees) as string[]) {
      assert.ok((groups[0]!.member_workspace_ids as string[]).includes(uuid));
    }
  } finally {
    w.cleanup();
  }
});

test('AC-19: renaming a workspace by hand does not fork the projection', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const before = Object.keys(w.state().workspaces).length;
    w.setState((s) => {
      for (const ws of Object.values(s.workspaces) as Array<Record<string, unknown>>) {
        if (ws.title === 'api') ws.title = 'renamed by a person';
      }
    });
    const r = runJson(w, ['open', w.root]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(Object.keys(w.state().workspaces).length, before);
    assert.equal(r.json.summary.present, 2);
  } finally {
    w.cleanup();
  }
});

test('AC-19: a person cd-ing out of a Tree does not fork the projection either', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const before = Object.keys(w.state().workspaces).length;
    w.setState((s) => {
      for (const ws of Object.values(s.workspaces) as Array<Record<string, unknown>>) {
        if (ws.title === 'api') ws.current_directory = '/tmp';
      }
    });
    const r = runJson(w, ['open', w.root]);
    assert.equal(Object.keys(w.state().workspaces).length, before);
    assert.equal(r.json.summary.present, 2);
  } finally {
    w.cleanup();
  }
});

test('AC-20 / D4: a stranger sitting inside a Tree is reported foreign and never adopted', () => {
  const w = makeWorld();
  try {
    w.setState((s) => {
      s.workspaces.stranger = {
        id: 'stranger',
        window_id: 'W1',
        title: 'someone else',
        current_directory: `${w.treePaths[`${w.grove}@api`]}/src`,
      };
    });
    const r = runJson(w, ['open', w.root]);
    assert.equal(r.code, 0, r.stderr);
    const foreign = r.json.items.filter((i: { classification: string }) => i.classification === 'foreign');
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0].workspace_id, 'stranger');
    assert.equal(foreign[0].owned, false);
    // It was not adopted: a fresh workspace exists for that Tree, and the stranger survives.
    assert.ok(w.state().workspaces.stranger);
    assert.equal(Object.keys(w.ledger()!.trees).length, 2);
    assert.ok(!Object.values(w.ledger()!.trees).includes('stranger'));
  } finally {
    w.cleanup();
  }
});

test('AC-16: a cmux restart that renumbers windows still re-identifies by UUID', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const ledgerBefore = w.ledger()!;
    // Restart: the window gets a new id, the workspaces keep theirs.
    w.setState((s) => {
      s.windows = [{ id: 'W9', title: 'after restart' }];
      for (const ws of Object.values(s.workspaces) as Array<Record<string, unknown>>) ws.window_id = 'W9';
      for (const g of Object.values(s.groups) as Array<Record<string, unknown>>) g.window_id = 'W9';
    });
    const r = runJson(w, ['status', w.root]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.summary.present, 2);
    assert.equal(r.json.window.id, 'W9');
    assert.deepEqual(w.ledger()!.trees, ledgerBefore.trees);
  } finally {
    w.cleanup();
  }
});

test('AC-10: a failure part-way leaves the ledger describing what exists, and a rerun completes', () => {
  const w = makeWorld({ trees: ['api', 'web', 'docs'] });
  try {
    // Fail after the first create. Two workspaces are never made; the group is never made.
    const first = run(w, ['open', w.root], { FAKE_CMUX_FAIL_AFTER: '1' });
    assert.notEqual(first.code, 0);
    const ledger = w.ledger()!;
    const created = Object.keys(w.state().workspaces);
    assert.equal(created.length, 1);
    assert.deepEqual(Object.values(ledger.trees), created, 'the ledger names exactly what exists');

    const second = runJson(w, ['open', w.root]);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.json.summary.present, 3);
    assert.equal(Object.keys(w.state().groups).length, 1);
    // The workspace made in the failed run was reused, not duplicated.
    assert.ok(Object.values(w.ledger()!.trees).includes(created[0]!));
  } finally {
    w.cleanup();
  }
});

test('D2: opening in a second window refuses with E_PROJECTION_CONFLICT, naming the first', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root, '--window', 'W1']);
    w.setState((s) => { s.windows.push({ id: 'W2', title: 'second' }); });

    const r = runJson(w, ['open', w.root, '--window', 'W2']);
    assert.equal(r.code, 13);
    assert.equal(r.json.class, 'E_PROJECTION_CONFLICT');
    assert.equal(r.json.evidence.found_window, 'W1');
    assert.match(r.json.remedy, /--relocate/);
    // Nothing was created in W2.
    const inW2 = (Object.values(w.state().workspaces) as Array<Record<string, unknown>>)
      .filter((x) => x.window_id === 'W2');
    assert.deepEqual(inW2, []);
  } finally {
    w.cleanup();
  }
});

test('D2: --relocate projects here and closes nothing there', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root, '--window', 'W1']);
    const w1Count = Object.keys(w.state().workspaces).length;
    w.setState((s) => { s.windows.push({ id: 'W2', title: 'second' }); });

    const r = runJson(w, ['open', w.root, '--window', 'W2', '--relocate']);
    assert.equal(r.code, 0, r.stderr);
    const state = w.state();
    const inW1 = (Object.values(state.workspaces) as Array<Record<string, unknown>>)
      .filter((x) => x.window_id === 'W1');
    const inW2 = (Object.values(state.workspaces) as Array<Record<string, unknown>>)
      .filter((x) => x.window_id === 'W2');
    assert.equal(inW1.length, w1Count, 'the old window is untouched');
    assert.equal(inW2.length, 3, 'anchor plus two Trees in the new window');
    assert.equal(w.ledger()!.window_id, 'W2');
  } finally {
    w.cleanup();
  }
});

test('D1: two windows and nothing naming one refuses a mutation, listing both', () => {
  const w = makeWorld();
  try {
    w.setState((s) => { s.windows.push({ id: 'W2', title: 'second' }); });
    const r = runJson(w, ['open', w.root]);
    assert.equal(r.code, 11);
    assert.equal(r.json.class, 'E_AMBIGUOUS_TARGET');
    assert.match(r.json.remedy, /--window/);
    assert.equal(Object.keys(w.state().workspaces).length, 0, 'nothing was projected anywhere');
  } finally {
    w.cleanup();
  }
});

test('D1: the same situation makes status report every window instead of refusing', () => {
  const w = makeWorld();
  try {
    w.setState((s) => { s.windows.push({ id: 'W2', title: 'second' }); });
    const r = runJson(w, ['status', w.root]);
    assert.equal(r.code, 0);
    assert.equal(r.json.windows.length, 2);
    assert.deepEqual(r.json.windows.map((x: { window: { id: string } }) => x.window.id), ['W1', 'W2']);
  } finally {
    w.cleanup();
  }
});

test('D1: --window focused opts into the fallback explicitly', () => {
  const w = makeWorld();
  try {
    w.setState((s) => { s.windows.push({ id: 'W2' }); s.focused = 'W2'; });
    const r = runJson(w, ['open', w.root, '--window', 'focused']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.window.id, 'W2');
  } finally {
    w.cleanup();
  }
});

test('sync --dry-run prints the same actions it would execute, and changes nothing', () => {
  const w = makeWorld();
  try {
    const dry = runJson(w, ['sync', w.root, '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(Object.keys(w.state().workspaces).length, 0);
    const planned = dry.json.actions.filter((a: { op: string }) => a.op === 'workspace.create');
    assert.equal(planned.length, 2);

    const real = runJson(w, ['sync', w.root]);
    const done = real.json.applied.filter((a: { op: string }) => a.op === 'workspace.create');
    assert.deepEqual(done.map((a: { tree: string }) => a.tree).sort(), planned.map((a: { tree: string }) => a.tree).sort());
  } finally {
    w.cleanup();
  }
});

test('AC-13: cmux not running refuses E_CMUX_UNAVAILABLE (3) with a start-cmux remedy', () => {
  const w = makeWorld();
  try {
    w.setState((s) => { s.running = false; });
    const r = runJson(w, ['status', w.root]);
    assert.equal(r.code, 3);
    assert.equal(r.json.class, 'E_CMUX_UNAVAILABLE');
    assert.match(r.json.remedy, /start cmux/);
  } finally {
    w.cleanup();
  }
});

test('AC-13: a wrong socket password refuses E_CMUX_AUTH (4)', () => {
  const w = makeWorld();
  try {
    w.setState((s) => { s.password = 'correct-horse'; });
    const r = runJson(w, ['status', w.root], { CMUX_SOCKET_PASSWORD: 'wrong' });
    assert.equal(r.code, 4);
    assert.equal(r.json.class, 'E_CMUX_AUTH');
  } finally {
    w.cleanup();
  }
});

test('AC-13: an unknown --window refuses E_CMUX_TARGET (5) and names the windows that exist', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['open', w.root, '--window', 'W404']);
    assert.equal(r.code, 5);
    assert.equal(r.json.class, 'E_CMUX_TARGET');
    assert.deepEqual(r.json.evidence.windows, ['W1']);
  } finally {
    w.cleanup();
  }
});

test('AC-18: a build below the minimum refuses; a merely different build warns and runs', () => {
  const low = makeWorld();
  try {
    low.setState((s) => { s.version = '0.60.0 (98) [aaaaaaaaa]'; });
    const r = runJson(low, ['status', low.root]);
    assert.equal(r.code, 7);
    assert.equal(r.json.class, 'E_CMUX_INCOMPATIBLE');
  } finally {
    low.cleanup();
  }

  const newer = makeWorld();
  try {
    newer.setState((s) => { s.version = '0.65.0 (110) [bbbbbbbbb]'; });
    const r = runJson(newer, ['open', newer.root]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.json.warnings.some((x: string) => /differs from the verified build/.test(x)));
    assert.equal(newer.ledger()!.cmux_build, '110');
  } finally {
    newer.cleanup();
  }
});

test('AC-18: a required method the build does not offer refuses E_CMUX_INCOMPATIBLE', () => {
  const w = makeWorld();
  try {
    w.setState((s) => { s.capabilities = ['workspace.list', 'workspace.create']; });
    const r = runJson(w, ['status', w.root]);
    assert.equal(r.code, 7);
    assert.match(r.json.message, /workspace\.group\.create/);
  } finally {
    w.cleanup();
  }
});

test('AC-13: a Grove root that does not exist refuses E_PRECONDITION (12)', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['status', `${w.base}/no-such-grove`]);
    assert.equal(r.code, 12);
    assert.equal(r.json.class, 'E_PRECONDITION');
  } finally {
    w.cleanup();
  }
});

test('AC-13: an unknown flag and an unknown command both refuse E_USAGE (2)', () => {
  const w = makeWorld();
  try {
    assert.equal(runJson(w, ['status', '--frobnicate']).code, 2);
    assert.equal(runJson(w, ['frobnicate']).code, 2);
  } finally {
    w.cleanup();
  }
});

test('AC-14: --json and human output describe the same run', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    w.removeTree(`${w.grove}@web`);
    const human = run(w, ['status', w.root]).stdout;
    const json = runJson(w, ['status', w.root]).json;
    for (const [cls, n] of Object.entries(json.summary) as Array<[string, number]>) {
      if (n === 0 || cls === 'ignore') continue;
      assert.match(human, new RegExp(`${n} ${cls}\\b`));
    }
  } finally {
    w.cleanup();
  }
});

test('AC-09: every mutation carries an explicit window_id', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const mutating = w.state().calls.filter((c: { method: string }) =>
      ['workspace.create', 'workspace.close', 'workspace.group.create', 'workspace.group.add'].includes(c.method),
    );
    assert.ok(mutating.length >= 3);
    for (const c of mutating) {
      assert.equal(c.params.window_id, 'W1', `${c.method} carried no window_id`);
    }
  } finally {
    w.cleanup();
  }
});

test('the RPC parameter names are the ones the source uses, not the CLI flag spellings', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const creates = w.state().calls.filter((c: { method: string }) => c.method === 'workspace.create');
    assert.ok(creates.length > 0);
    for (const c of creates) {
      assert.ok('working_directory' in c.params, 'workspace.create must send working_directory');
      assert.ok('title' in c.params, 'workspace.create must send title');
      assert.ok(!('cwd' in c.params), 'cwd is the CLI spelling and is silently ignored');
      assert.ok(!('name' in c.params), 'name is the CLI spelling and is silently ignored');
    }
    const groups = w.state().calls.filter((c: { method: string }) => c.method === 'workspace.group.create');
    for (const c of groups) {
      assert.ok('name' in c.params && 'cwd' in c.params, 'group.create does take name and cwd');
      assert.ok(Array.isArray(c.params.child_workspace_ids));
    }
  } finally {
    w.cleanup();
  }
});

test('AC-08: a split projection reclaims without naming either stranger group', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const ledger = w.ledger()!;
    const [uuidA, uuidB] = Object.values(ledger.trees) as string[];

    // A person dissolves our group and files our two workspaces into two groups of their own.
    // This used to refuse and point at --anchor, which was the last place ownership could be
    // inferred from position. It reclaims instead, naming only our own workspace ids.
    w.setState((s) => {
      s.workspaces.anchorA = { id: 'anchorA', window_id: 'W1', title: 'one', current_directory: '/a' };
      s.workspaces.anchorB = { id: 'anchorB', window_id: 'W1', title: 'two', current_directory: '/b' };
      s.groups = {
        GA: { id: 'GA', window_id: 'W1', name: 'one', anchor_workspace_id: 'anchorA', member_workspace_ids: ['anchorA', uuidA!] },
        GB: { id: 'GB', window_id: 'W1', name: 'two', anchor_workspace_id: 'anchorB', member_workspace_ids: ['anchorB', uuidB!] },
      };
    });
    writeFileSync(
      `${w.root}/.grove-cmux/projection.json`,
      JSON.stringify({ ...ledger, group_id: null, anchor_workspace_id: null }, null, 2),
    );

    const r = runJson(w, ['sync', w.root]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.summary.present, 2);

    // Neither stranger group was named by any call; cmux moved the members out.
    const named = (w.state().calls as Array<{ params: Record<string, unknown> }>)
      .map((c) => c.params.group_id)
      .filter(Boolean);
    assert.ok(!named.includes('GA') && !named.includes('GB'), 'a stranger group was named');
    assert.deepEqual(w.state().groups.GA.member_workspace_ids, ['anchorA']);
    assert.deepEqual(w.state().groups.GB.member_workspace_ids, ['anchorB']);
    assert.notEqual(w.ledger()!.group_id, 'GA');
    assert.notEqual(w.ledger()!.group_id, 'GB');
  } finally {
    w.cleanup();
  }
});

test('--anchor is gone, and naming it is a usage error rather than a silent no-op', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['open', w.root, '--anchor', 'anything']);
    assert.equal(r.code, 2);
    assert.equal(r.json.class, 'E_USAGE');
    assert.equal(Object.keys(w.state().workspaces).length, 0);
  } finally {
    w.cleanup();
  }
});

test('status from a cmux terminal in another window reports the projection, not "missing"', () => {
  const w = makeWorld();
  try {
    assert.equal(run(w, ['open', w.root, '--window', 'W1']).code, 0);
    // A second window, and a caller signature naming it — an agent in a cmux terminal there.
    w.setState((s) => {
      s.windows.push({ id: 'W2', title: 'two' });
      s.caller = 'W2';
    });

    const r = runJson(w, ['status', w.root]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.window.id, 'W1', 'the read followed the caller instead of the ledger');
    assert.equal(r.json.window.source, 'ledger');
    assert.equal(r.json.summary.present, 2);
    assert.equal(r.json.summary.missing ?? 0, 0, 'a projected Grove was reported missing');
  } finally {
    w.cleanup();
  }
});

test('open --agent on an already-projected Grove says it started nothing', () => {
  const w = makeWorld();
  try {
    assert.equal(run(w, ['open', w.root]).code, 0);
    const before = Object.keys(w.state().workspaces).length;

    const r = runJson(w, ['open', w.root, '--agent', 'claude']);
    assert.equal(r.code, 0, r.stderr);
    // An agent rides on workspace.create, so with nothing created nothing starts. The clean
    // exit with no message was indistinguishable from a launch.
    assert.equal(Object.keys(w.state().workspaces).length, before);
    assert.ok(
      r.json.warnings.some((x: string) => /started nothing/.test(x) && /run --tree/.test(x)),
      `no warning about the no-op launch: ${JSON.stringify(r.json.warnings)}`,
    );
  } finally {
    w.cleanup();
  }
});

test('a command that cannot use "--" refuses instead of silently dropping what follows', () => {
  const w = makeWorld();
  try {
    for (const cmd of ['open', 'sync', 'status']) {
      const r = runJson(w, [cmd, w.root, '--', 'do', 'the', 'thing']);
      assert.equal(r.code, 2, `${cmd} accepted and ignored everything after --`);
      assert.equal(r.json.class, 'E_USAGE');
      // runJson appends --json, which lands after the separator too — itself the point:
      // everything past `--` is captured rather than parsed.
      assert.deepEqual(r.json.evidence.after_separator.slice(0, 3), ['do', 'the', 'thing']);
      assert.match(r.json.remedy, /run --tree/);
    }
  } finally {
    w.cleanup();
  }
});
