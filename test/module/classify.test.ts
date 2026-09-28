import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, type ClassifyInput } from '../../src/classify.ts';
import { __clearWorktreeCache, __setWorktreeForTest } from '../../src/git.ts';
import { emptyLedger, type Ledger } from '../../src/ledger.ts';
import type { Grove } from '../../src/grove.ts';

const ROOT = '/g/feat-checkout';

function grove(treeNames = ['feat-checkout@api', 'feat-checkout@web']): Grove {
  return {
    name: 'feat-checkout',
    root: ROOT,
    skipped: [],
    trees: treeNames.map((name) => ({
      name,
      shortName: name.split('@')[1]!,
      path: `${ROOT}/trees/${name}`,
      existsOnDisk: true,
    })),
  };
}

function ledgerWith(trees: Record<string, string>, extra: Partial<Ledger> = {}): Ledger {
  return { ...emptyLedger('feat-checkout'), trees, ...extra };
}

function run(input: Partial<ClassifyInput> & { grove?: Grove }) {
  __clearWorktreeCache();
  return classify({
    grove: input.grove ?? grove(),
    ledger: input.ledger ?? null,
    workspaces: input.workspaces ?? [],
    groups: input.groups ?? [],
  });
}

test('a Grove with no ledger classifies every Tree missing and plans one create each', () => {
  const p = run({});
  assert.deepEqual(
    p.items.map((i) => i.classification),
    ['missing', 'missing'],
  );
  assert.equal(p.items.every((i) => i.reason === 'never_projected'), true);
  assert.equal(p.actions.filter((a) => a.op === 'workspace.create').length, 2);
  assert.equal(p.actions.filter((a) => a.op === 'group.create').length, 1);
  assert.equal(p.group.state, 'never_created');
});

test('a fully projected Grove is all present and plans nothing', () => {
  const p = run({
    ledger: ledgerWith(
      { 'feat-checkout@api': 'wsA', 'feat-checkout@web': 'wsB' },
      { group_id: 'G1', anchor_workspace_id: 'anchor' },
    ),
    workspaces: [
      { id: 'wsA', current_directory: `${ROOT}/trees/feat-checkout@api` },
      { id: 'wsB', current_directory: `${ROOT}/trees/feat-checkout@web` },
      { id: 'anchor', current_directory: ROOT },
    ],
    groups: [
      { id: 'G1', name: 'feat-checkout', anchor_workspace_id: 'anchor', member_workspace_ids: ['wsA', 'wsB'] },
    ],
  });
  assert.deepEqual(p.summary.present, 2);
  assert.equal(p.actions.length, 0);
  assert.equal(p.group.state, 'present');
});

test('S7.7: an ungroup makes our workspaces detached, not missing, so nothing is duplicated', () => {
  const p = run({
    ledger: ledgerWith(
      { 'feat-checkout@api': 'wsA', 'feat-checkout@web': 'wsB' },
      { group_id: 'G1', anchor_workspace_id: 'anchor' },
    ),
    // The group is gone; every workspace survived belonging to nothing.
    workspaces: [
      { id: 'wsA', current_directory: `${ROOT}/trees/feat-checkout@api` },
      { id: 'wsB', current_directory: `${ROOT}/trees/feat-checkout@web` },
      { id: 'anchor', current_directory: ROOT },
    ],
    groups: [],
  });
  assert.deepEqual(
    p.items.filter((i) => i.tree).map((i) => i.classification),
    ['detached', 'detached'],
  );
  assert.equal(p.group.state, 'dissolved');
  assert.equal(p.actions.filter((a) => a.op === 'workspace.create').length, 0);
  assert.equal(p.actions.filter((a) => a.op === 'group.attach').length, 2);
  assert.equal(p.actions.filter((a) => a.op === 'group.create').length, 1);
});

test('a ledger row whose workspace is gone is missing, and re-created', () => {
  const p = run({
    ledger: ledgerWith({ 'feat-checkout@api': 'gone', 'feat-checkout@web': 'wsB' }, {
      group_id: 'G1',
      anchor_workspace_id: 'anchor',
    }),
    workspaces: [
      { id: 'wsB', current_directory: `${ROOT}/trees/feat-checkout@web` },
      { id: 'anchor', current_directory: ROOT },
    ],
    groups: [{ id: 'G1', anchor_workspace_id: 'anchor', member_workspace_ids: ['wsB'] }],
  });
  const api = p.items.find((i) => i.tree === 'feat-checkout@api')!;
  assert.equal(api.classification, 'missing');
  assert.equal(api.reason, 'workspace_not_found');
  assert.equal(api.owned, true);
});

test('a Tree removed from disk is stale, and its close action is marked destructive', () => {
  const p = run({
    grove: grove(['feat-checkout@web']),
    ledger: ledgerWith({ 'feat-checkout@api': 'wsA', 'feat-checkout@web': 'wsB' }, {
      group_id: 'G1',
      anchor_workspace_id: 'anchor',
    }),
    workspaces: [
      { id: 'wsA', current_directory: `${ROOT}/trees/feat-checkout@api` },
      { id: 'wsB', current_directory: `${ROOT}/trees/feat-checkout@web` },
      { id: 'anchor', current_directory: ROOT },
    ],
    groups: [
      { id: 'G1', anchor_workspace_id: 'anchor', member_workspace_ids: ['wsA', 'wsB'] },
    ],
  });
  const stale = p.items.find((i) => i.classification === 'stale')!;
  assert.equal(stale.tree, 'feat-checkout@api');
  const close = p.actions.find((a) => a.op === 'workspace.close')!;
  assert.equal(close.destructive, true);
  assert.equal(close.reason, 'tree_removed');
});

test('D4: a workspace inside a Tree is never adopted, at any depth', () => {
  __setWorktreeForTest(`${ROOT}/trees/feat-checkout@api/src`, `${ROOT}/trees/feat-checkout@api`);
  const p = classify({
    grove: grove(['feat-checkout@api']),
    ledger: null,
    workspaces: [{ id: 'strangerWs', current_directory: `${ROOT}/trees/feat-checkout@api/src` }],
    groups: [],
  });
  const foreign = p.items.find((i) => i.workspace_id === 'strangerWs')!;
  assert.equal(foreign.classification, 'foreign');
  assert.equal(foreign.owned, false);
  assert.equal(foreign.reason, 'not_in_ledger');
  // It resolves to the Tree, and is still not adopted: the Tree is created fresh.
  assert.equal(foreign.resolved_worktree, `${ROOT}/trees/feat-checkout@api`);
  assert.equal(p.actions.filter((a) => a.op === 'workspace.create').length, 1);
  // Nothing in the plan ever touches it.
  assert.equal(p.actions.some((a) => a.workspace_id === 'strangerWs'), false);
});

test('D4: an exact match at the Tree root is not adopted either', () => {
  __setWorktreeForTest(`${ROOT}/trees/feat-checkout@api`, `${ROOT}/trees/feat-checkout@api`);
  const p = classify({
    grove: grove(['feat-checkout@api']),
    ledger: null,
    workspaces: [{ id: 'strangerWs', current_directory: `${ROOT}/trees/feat-checkout@api` }],
    groups: [],
  });
  assert.equal(p.items.find((i) => i.workspace_id === 'strangerWs')!.classification, 'foreign');
  assert.equal(p.actions.filter((a) => a.op === 'workspace.create').length, 1);
});

test('M9: a stranger at the Grove root is foreign, never the anchor', () => {
  const p = run({
    workspaces: [{ id: 'strangerWs', current_directory: ROOT }],
  });
  const item = p.items.find((i) => i.workspace_id === 'strangerWs')!;
  assert.equal(item.classification, 'foreign');
  assert.equal(item.owned, false);
});

test('D5: a Tree-path workspace inside a stranger group is foreign, carrying that group', () => {
  __setWorktreeForTest(`${ROOT}/trees/feat-checkout@api`, `${ROOT}/trees/feat-checkout@api`);
  const p = classify({
    grove: grove(['feat-checkout@api']),
    ledger: null,
    workspaces: [{ id: 'sw', current_directory: `${ROOT}/trees/feat-checkout@api` }],
    groups: [{ id: 'GX', name: 'scratch', anchor_workspace_id: 'other', member_workspace_ids: ['sw'] }],
  });
  const item = p.items.find((i) => i.workspace_id === 'sw')!;
  assert.equal(item.classification, 'foreign');
  assert.equal(item.in_group, 'GX');
  assert.equal(item.in_group_name, 'scratch');
  assert.equal(p.actions.some((a) => a.workspace_id === 'sw'), false);
});

test('S7.5: a ledger-named workspace dragged into a stranger group is ours, and re-attached', () => {
  const p = run({
    grove: grove(['feat-checkout@api']),
    ledger: ledgerWith({ 'feat-checkout@api': 'wsA' }, {
      group_id: 'G1',
      anchor_workspace_id: 'anchor',
    }),
    workspaces: [
      { id: 'wsA', current_directory: `${ROOT}/trees/feat-checkout@api` },
      { id: 'anchor', current_directory: ROOT },
    ],
    groups: [
      { id: 'G1', anchor_workspace_id: 'anchor', member_workspace_ids: [] },
      { id: 'GX', name: 'scratch', anchor_workspace_id: 'other', member_workspace_ids: ['wsA'] },
    ],
  });
  const item = p.items.find((i) => i.tree === 'feat-checkout@api')!;
  assert.equal(item.classification, 'detached');
  assert.equal(item.owned, true);
  assert.equal(p.actions.some((a) => a.op === 'group.attach' && a.workspace_id === 'wsA'), true);
});

test('ledger members split across two groups reclaims, naming only our own ids', () => {
  const p = run({
    ledger: ledgerWith({ 'feat-checkout@api': 'wsA', 'feat-checkout@web': 'wsB' }),
    workspaces: [
      { id: 'wsA', current_directory: `${ROOT}/trees/feat-checkout@api` },
      { id: 'wsB', current_directory: `${ROOT}/trees/feat-checkout@web` },
    ],
    groups: [
      { id: 'GA', anchor_workspace_id: 'a1', member_workspace_ids: ['a1', 'wsA'] },
      { id: 'GB', anchor_workspace_id: 'a2', member_workspace_ids: ['a2', 'wsB'] },
    ],
  });
  // Neither group is ours, so both workspaces are detached and get reclaimed into a new one.
  // That names only wsA and wsB; cmux's move semantics remove them from GA and GB, which is
  // the same thing that happens for a single group and was already settled.
  assert.deepEqual(
    p.items.filter((i) => i.tree).map((i) => i.classification),
    ['detached', 'detached'],
  );
  assert.equal(p.actions.filter((a) => a.op === 'group.create').length, 1);
  assert.equal(p.actions.filter((a) => a.op === 'group.attach').length, 2);
  assert.equal(
    p.actions.some((a) => a.workspace_id === 'a1' || a.workspace_id === 'a2'),
    false,
    'the plan named a stranger anchor',
  );
});

test('a group anchored on our recorded anchor is ours even after its id changed', () => {
  const p = run({
    ledger: ledgerWith({ 'feat-checkout@api': 'wsA' }, {
      group_id: 'GONE',
      anchor_workspace_id: 'anchor',
    }),
    grove: grove(['feat-checkout@api']),
    workspaces: [
      { id: 'wsA', current_directory: `${ROOT}/trees/feat-checkout@api` },
      { id: 'anchor', current_directory: ROOT },
    ],
    groups: [{ id: 'GNEW', anchor_workspace_id: 'anchor', member_workspace_ids: ['anchor', 'wsA'] }],
  });
  assert.equal(p.items.find((i) => i.tree === 'feat-checkout@api')!.classification, 'present');
  assert.equal(p.group.state, 'present');
  assert.equal(p.actions.length, 0);
});

test('a group merely holding our workspaces is never ours', () => {
  const p = run({
    grove: grove(['feat-checkout@api']),
    ledger: ledgerWith({ 'feat-checkout@api': 'wsA' }, { group_id: 'GONE', anchor_workspace_id: 'gone' }),
    workspaces: [{ id: 'wsA', current_directory: `${ROOT}/trees/feat-checkout@api` }],
    groups: [{ id: 'GTHEIRS', name: 'theirs', anchor_workspace_id: 'theirAnchor', member_workspace_ids: ['theirAnchor', 'wsA'] }],
  });
  assert.equal(p.items.find((i) => i.tree === 'feat-checkout@api')!.classification, 'detached');
  assert.equal(p.group.state, 'dissolved');
  assert.equal(p.actions.filter((a) => a.op === 'group.create').length, 1);
  assert.equal(p.actions.some((a) => a.workspace_id === 'theirAnchor'), false);
});

test('M13: a person cd-ing out of a Tree does not change its classification', () => {
  const p = run({
    grove: grove(['feat-checkout@api']),
    ledger: ledgerWith({ 'feat-checkout@api': 'wsA' }, {
      group_id: 'G1',
      anchor_workspace_id: 'anchor',
    }),
    // The live cwd has moved to /tmp. Identity is the UUID, so nothing moves.
    workspaces: [
      { id: 'wsA', current_directory: '/tmp' },
      { id: 'anchor', current_directory: ROOT },
    ],
    groups: [{ id: 'G1', anchor_workspace_id: 'anchor', member_workspace_ids: ['wsA'] }],
  });
  assert.equal(p.items.find((i) => i.tree === 'feat-checkout@api')!.classification, 'present');
  assert.equal(p.actions.length, 0);
});

test('R1: editing a title or description does not fork the projection', () => {
  const p = run({
    grove: grove(['feat-checkout@api']),
    ledger: ledgerWith({ 'feat-checkout@api': 'wsA' }, {
      group_id: 'G1',
      anchor_workspace_id: 'anchor',
    }),
    workspaces: [
      { id: 'wsA', custom_title: 'renamed by hand', current_directory: `${ROOT}/trees/feat-checkout@api` },
      { id: 'anchor', current_directory: ROOT },
    ],
    groups: [{ id: 'G1', anchor_workspace_id: 'anchor', member_workspace_ids: ['wsA'] }],
  });
  assert.equal(p.items.find((i) => i.tree === 'feat-checkout@api')!.classification, 'present');
  assert.equal(p.actions.length, 0);
});

test('unrelated workspaces are ignore, and never appear in any action', () => {
  const p = run({
    workspaces: [{ id: 'randomWs', current_directory: '/somewhere/else' }],
  });
  assert.equal(p.items.find((i) => i.workspace_id === 'randomWs')!.classification, 'ignore');
  assert.equal(p.actions.some((a) => a.workspace_id === 'randomWs'), false);
});

test('every action names an op from the closed enum and a boolean destructive flag', () => {
  const ops = new Set(['workspace.create', 'group.create', 'group.attach', 'workspace.close']);
  const p = run({
    grove: grove(['feat-checkout@web']),
    ledger: ledgerWith({ 'feat-checkout@api': 'wsA' }, { group_id: 'G1', anchor_workspace_id: 'anchor' }),
    workspaces: [
      { id: 'wsA', current_directory: `${ROOT}/trees/feat-checkout@api` },
      { id: 'anchor', current_directory: ROOT },
    ],
    groups: [{ id: 'G1', anchor_workspace_id: 'anchor', member_workspace_ids: ['wsA'] }],
  });
  assert.ok(p.actions.length > 0);
  for (const a of p.actions) {
    assert.ok(ops.has(a.op), `unexpected op ${a.op}`);
    assert.equal(typeof a.destructive, 'boolean');
    assert.ok(typeof a.reason === 'string' && a.reason.length > 0);
  }
});
