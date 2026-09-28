import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, run, runJson } from '../helpers/world.mjs';
import { REQUIRED_METHODS } from '../../src/cmux.ts';

const MUTATING = new Set([
  'workspace.create',
  'workspace.close',
  'workspace.group.create',
  'workspace.group.add',
  'workspace.group.ungroup',
  'surface.create',
]);

function open(world: ReturnType<typeof makeWorld>) {
  const result = run(world, ['open', world.root]);
  assert.equal(result.code, 0, result.stderr);
}

function resetJournal(world: ReturnType<typeof makeWorld>) {
  world.setState((state) => {
    state.calls = [];
    state.mutations = 0;
  });
}

function mutatingCalls(world: ReturnType<typeof makeWorld>) {
  return world.state().calls.filter((call: { method: string }) => MUTATING.has(call.method));
}

function ledgerBytes(world: ReturnType<typeof makeWorld>) {
  return readFileSync(join(world.root, '.grove-cmux', 'projection.json'), 'utf8');
}

test('close command help is available without cmux', () => {
  const world = makeWorld();
  try {
    world.setState((state) => { state.running = false; });
    const result = run(world, ['close', '--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--keep-anchor/);
    assert.match(result.stdout, /--forget/);
  } finally {
    world.cleanup();
  }
});

test('AC-23: close removes every ledgered workspace and group, then clears the ledger', () => {
  const world = makeWorld();
  try {
    open(world);
    const before = world.ledger()!;
    const owned = new Set([...Object.values(before.trees), before.anchor_workspace_id]);
    resetJournal(world);

    const result = runJson(world, ['close', world.root]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok([...owned].every((id) => id && !world.state().workspaces[id]));
    assert.equal(world.state().groups[before.group_id], undefined);
    assert.deepEqual(world.ledger(), {
      schema: before.schema,
      grove: before.grove,
      cmux_build: before.cmux_build,
      window_id: null,
      group_id: null,
      anchor_workspace_id: null,
      trees: {},
    });
    assert.deepEqual(result.json.actions, result.json.applied);
  } finally {
    world.cleanup();
  }
});

test('AC-24: close without a ledger is E_PRECONDITION and issues no mutation', () => {
  const world = makeWorld();
  try {
    const result = runJson(world, ['close', world.root]);
    assert.equal(result.code, 12);
    assert.equal(result.json.class, 'E_PRECONDITION');
    assert.match(result.json.remedy, /grove-cmux status/);
    assert.deepEqual(mutatingCalls(world), []);
  } finally {
    world.cleanup();
  }
});

test('AC-25: every close mutation names an id from the pre-run ledger', () => {
  const world = makeWorld();
  try {
    open(world);
    const ledger = world.ledger()!;
    const permitted = new Set([
      ...Object.values(ledger.trees),
      ledger.group_id,
      ledger.anchor_workspace_id,
    ]);
    resetJournal(world);
    const result = runJson(world, ['close', world.root]);
    assert.equal(result.code, 0, result.stderr);
    for (const call of mutatingCalls(world)) {
      for (const key of ['workspace_id', 'group_id']) {
        if (call.params[key]) assert.ok(permitted.has(call.params[key]), `${key} was not ledgered`);
      }
    }
    assert.deepEqual(world.ledger()!.trees, {});
  } finally {
    world.cleanup();
  }
});

test('AC-26: a foreign member survives close with the outlived group and is named in warnings', () => {
  const world = makeWorld();
  try {
    open(world);
    const ledger = world.ledger()!;
    world.setState((state) => {
      state.workspaces.stranger = {
        id: 'stranger', window_id: 'W1', title: 'notes', current_directory: '/tmp',
      };
      state.groups[ledger.group_id].member_workspace_ids.push('stranger');
    });
    resetJournal(world);

    const result = runJson(world, ['close', world.root]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(world.state().workspaces.stranger);
    assert.ok(world.state().groups[ledger.group_id]);
    assert.deepEqual(world.state().groups[ledger.group_id].member_workspace_ids, ['stranger']);
    assert.ok(result.json.warnings.some((warning: string) =>
      warning.includes(ledger.group_id) && warning.includes('stranger') && /outlived/.test(warning),
    ));
    assert.ok(!mutatingCalls(world).some((call: { params: Record<string, string> }) =>
      call.params.workspace_id === 'stranger',
    ));
  } finally {
    world.cleanup();
  }
});

test('AC-27: --forget removes ownership only after a clean verified close', () => {
  const clean = makeWorld();
  try {
    open(clean);
    const result = runJson(clean, ['close', clean.root, '--forget']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(join(clean.root, '.grove-cmux')), false);
  } finally {
    clean.cleanup();
  }

  const failed = makeWorld();
  try {
    open(failed);
    resetJournal(failed);
    const before = ledgerBytes(failed);
    const result = runJson(failed, ['close', failed.root, '--forget'], {
      FAKE_CMUX_FAIL_AFTER: '0',
    });
    assert.notEqual(result.code, 0);
    assert.equal(existsSync(join(failed.root, '.grove-cmux')), true);
    assert.equal(ledgerBytes(failed), before);
    assert.equal(Object.keys(failed.state().workspaces).length, 3);
  } finally {
    failed.cleanup();
  }
});

test('AC-28: --keep-anchor closes members, dissolves a safe group, and releases the anchor', () => {
  const world = makeWorld();
  try {
    open(world);
    const before = world.ledger()!;
    const anchor = before.anchor_workspace_id;
    resetJournal(world);

    const result = runJson(world, ['close', world.root, '--keep-anchor']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(world.state().workspaces[anchor]);
    assert.equal(world.state().groups[before.group_id], undefined);
    assert.ok(!Object.values(world.state().groups).some((group: any) =>
      group.member_workspace_ids.includes(anchor),
    ));
    assert.deepEqual(world.ledger(), {
      schema: before.schema,
      grove: before.grove,
      cmux_build: before.cmux_build,
      window_id: null,
      group_id: null,
      anchor_workspace_id: null,
      trees: {},
    });
    assert.ok(result.json.actions.some((action: { op: string }) => action.op === 'group.ungroup'));
  } finally {
    world.cleanup();
  }
});

test('AC-18: close --keep-anchor requires ungroup capability before mutation', () => {
  const world = makeWorld();
  try {
    open(world);
    const before = ledgerBytes(world);
    world.setState((state) => {
      state.capabilities = REQUIRED_METHODS.filter(
        (method) => method !== 'workspace.group.ungroup',
      );
      state.calls = [];
      state.mutations = 0;
    });

    const result = runJson(world, ['close', world.root, '--keep-anchor']);
    assert.equal(result.code, 7);
    assert.equal(result.json.class, 'E_CMUX_INCOMPATIBLE');
    assert.match(result.json.message, /workspace\.group\.ungroup/);
    assert.deepEqual(mutatingCalls(world), []);
    assert.equal(world.state().mutations, 0);
    assert.equal(ledgerBytes(world), before);
  } finally {
    world.cleanup();
  }
});

test('AC-18: close --keep-anchor refuses before mutation when the method list is unavailable', () => {
  const world = makeWorld();
  try {
    open(world);
    const before = ledgerBytes(world);
    world.setState((state) => {
      state.capabilities = null;
      state.missing_methods = ['workspace.group.ungroup'];
      state.calls = [];
      state.mutations = 0;
    });

    const result = runJson(world, ['close', world.root, '--keep-anchor']);
    assert.equal(result.code, 7, result.stderr);
    assert.equal(result.json.class, 'E_CMUX_INCOMPATIBLE');
    // The defect this guards: the refusal arrived only after every Tree had been closed.
    const mutated = mutatingCalls(world).map((call: { method: string }) => call.method);
    assert.equal(mutated.length, 0, `mutated before refusing: ${mutated.join(', ')}`);
    assert.equal(world.state().mutations, 0);
    assert.equal(Object.keys(world.state().workspaces).length, 3);
    assert.equal(ledgerBytes(world), before);
    assert.match(result.json.message, /workspace\.group\.ungroup/);
    assert.equal(result.json.evidence.method_list, 'unavailable');
  } finally {
    world.cleanup();
  }
});

test('AC-33: --keep-anchor with no group left to dissolve needs no ungroup evidence', () => {
  const world = makeWorld();
  try {
    open(world);
    const ledger = world.ledger()!;
    world.setState((state) => {
      delete state.groups[ledger.group_id];
      state.capabilities = null;
      state.missing_methods = ['workspace.group.ungroup'];
    });
    resetJournal(world);
    const result = runJson(world, ['close', world.root, '--keep-anchor']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(world.state().workspaces[ledger.anchor_workspace_id]);
    assert.deepEqual(world.ledger()!.trees, {});
  } finally {
    world.cleanup();
  }
});

test('AC-29: close --dry-run is read-only and prints the exact live action array', () => {
  const world = makeWorld();
  try {
    open(world);
    resetJournal(world);
    const dry = runJson(world, ['close', world.root, '--keep-anchor', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(mutatingCalls(world), []);
    assert.ok(dry.json.actions.some((action: { op: string }) => action.op === 'group.ungroup'));

    resetJournal(world);
    const live = runJson(world, ['close', world.root, '--keep-anchor']);
    assert.equal(live.code, 0, live.stderr);
    assert.deepEqual(live.json.actions, dry.json.actions);
    assert.deepEqual(live.json.applied, dry.json.actions);
  } finally {
    world.cleanup();
  }
});

test('AC-32: close finds ledgered workspaces in their actual windows, including a split', () => {
  const world = makeWorld();
  try {
    open(world);
    const ledger = world.ledger()!;
    const treeIds = Object.values(ledger.trees) as string[];
    world.setState((state) => {
      state.windows.push({ id: 'W2', title: 'second' });
      state.workspaces[treeIds[0]!].window_id = 'W2';
      state.workspaces[ledger.anchor_workspace_id].window_id = 'W2';
    });
    resetJournal(world);

    const result = runJson(world, ['close', world.root]);
    assert.equal(result.code, 0, result.stderr);
    const calls = mutatingCalls(world).filter((call: { method: string }) =>
      call.method === 'workspace.close',
    );
    const windowsById = new Map(calls.map((call: any) => [call.params.workspace_id, call.params.window_id]));
    assert.equal(windowsById.get(treeIds[0]!), 'W2');
    assert.equal(windowsById.get(treeIds[1]!), 'W1');
    assert.equal(windowsById.get(ledger.anchor_workspace_id), 'W2');
    assert.equal(Object.keys(world.state().workspaces).length, 0);
  } finally {
    world.cleanup();
  }
});

test('AC-33: --keep-anchor treats an already-gone group as a successful no-op', () => {
  const world = makeWorld();
  try {
    open(world);
    const ledger = world.ledger()!;
    world.setState((state) => { delete state.groups[ledger.group_id]; });
    resetJournal(world);
    const result = runJson(world, ['close', world.root, '--keep-anchor']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(world.state().workspaces[ledger.anchor_workspace_id]);
    assert.ok(result.json.warnings.some((warning: string) => /already gone/.test(warning)));
    assert.ok(!mutatingCalls(world).some((call: { method: string }) =>
      call.method === 'workspace.group.ungroup',
    ));
  } finally {
    world.cleanup();
  }
});

test('close clears a projection whose recorded window and objects are already gone', () => {
  const world = makeWorld();
  try {
    open(world);
    const before = world.ledger()!;
    world.setState((state) => {
      state.workspaces = {};
      state.groups = {};
      state.windows = [{ id: 'W2', title: 'replacement' }];
      state.calls = [];
      state.mutations = 0;
    });
    const result = runJson(world, ['close', world.root]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(mutatingCalls(world), []);
    assert.deepEqual(world.ledger(), {
      schema: before.schema,
      grove: before.grove,
      cmux_build: before.cmux_build,
      window_id: null,
      group_id: null,
      anchor_workspace_id: null,
      trees: {},
    });
  } finally {
    world.cleanup();
  }
});

test('AC-33: --keep-anchor leaves a group with a foreign member intact and skips ungroup', () => {
  const world = makeWorld();
  try {
    open(world);
    const ledger = world.ledger()!;
    world.setState((state) => {
      state.workspaces.foreign = {
        id: 'foreign', window_id: 'W1', title: 'foreign', current_directory: '/tmp',
      };
      state.groups[ledger.group_id].member_workspace_ids.push('foreign');
    });
    resetJournal(world);
    const result = runJson(world, ['close', world.root, '--keep-anchor']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      world.state().groups[ledger.group_id].member_workspace_ids,
      [ledger.anchor_workspace_id, 'foreign'],
    );
    assert.ok(result.json.warnings.some((warning: string) => warning.includes('foreign')));
    assert.ok(!result.json.actions.some((action: { op: string }) => action.op === 'group.ungroup'));
  } finally {
    world.cleanup();
  }
});

test('AC-33: --keep-anchor never names the foreign group holding the retained anchor', () => {
  const world = makeWorld();
  try {
    open(world);
    const ledger = world.ledger()!;
    const treeIds = Object.values(ledger.trees) as string[];
    world.setState((state) => {
      const ours = state.groups[ledger.group_id];
      ours.anchor_workspace_id = treeIds[0]!;
      ours.member_workspace_ids = [...treeIds];
      state.workspaces.foreign = {
        id: 'foreign', window_id: 'W1', title: 'foreign', current_directory: '/tmp',
      };
      state.groups.GFOREIGN = {
        id: 'GFOREIGN',
        window_id: 'W1',
        name: 'foreign',
        anchor_workspace_id: ledger.anchor_workspace_id,
        member_workspace_ids: [ledger.anchor_workspace_id, 'foreign'],
      };
    });
    const foreignBefore = JSON.stringify(world.state().groups.GFOREIGN);
    resetJournal(world);
    const result = runJson(world, ['close', world.root, '--keep-anchor']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.stringify(world.state().groups.GFOREIGN), foreignBefore);
    assert.ok(result.json.warnings.some((warning: string) => warning.includes('GFOREIGN')));
    for (const call of mutatingCalls(world)) {
      assert.notEqual(call.params.group_id, 'GFOREIGN');
      assert.notEqual(call.params.workspace_id, ledger.anchor_workspace_id);
    }
  } finally {
    world.cleanup();
  }
});

test('AC-34: an unreadable workspace window refuses before mutation with identical ledger bytes', () => {
  const world = makeWorld();
  try {
    open(world);
    world.setState((state) => { state.windows.push({ id: 'W2', title: 'second' }); });
    resetJournal(world);
    const before = ledgerBytes(world);
    const result = runJson(world, ['close', world.root], {
      FAKE_CMUX_FAIL_READ: 'workspace.list',
      FAKE_CMUX_FAIL_READ_WINDOW: 'W2',
    });
    assert.equal(result.code, 5);
    assert.equal(result.json.class, 'E_CMUX_TARGET');
    assert.equal(result.json.evidence.window_id, 'W2');
    assert.deepEqual(mutatingCalls(world), []);
    assert.equal(ledgerBytes(world), before);
  } finally {
    world.cleanup();
  }
});

test('AC-34: an unreadable group window refuses --keep-anchor before mutation', () => {
  const world = makeWorld();
  try {
    open(world);
    world.setState((state) => { state.windows.push({ id: 'W2', title: 'second' }); });
    resetJournal(world);
    const before = ledgerBytes(world);
    const result = runJson(world, ['close', world.root, '--keep-anchor'], {
      FAKE_CMUX_FAIL_READ: 'workspace.group.list',
      FAKE_CMUX_FAIL_READ_WINDOW: 'W2',
    });
    assert.equal(result.code, 5);
    assert.equal(result.json.evidence.window_id, 'W2');
    assert.deepEqual(mutatingCalls(world), []);
    assert.equal(ledgerBytes(world), before);
  } finally {
    world.cleanup();
  }
});

test('AC-34: a failed post-close verification withholds --forget and final ledger clearing', () => {
  const world = makeWorld();
  try {
    open(world);
    const before = world.ledger()!;
    resetJournal(world);
    const result = runJson(world, ['close', world.root, '--forget'], {
      FAKE_CMUX_FAIL_READ: 'workspace.list',
      FAKE_CMUX_FAIL_READ_WINDOW: 'W1',
      FAKE_CMUX_FAIL_READ_AFTER: '1',
    });
    assert.equal(result.code, 5);
    assert.equal(result.json.evidence.window_id, 'W1');
    assert.equal(existsSync(join(world.root, '.grove-cmux')), true);
    assert.equal(world.ledger()!.group_id, before.group_id, 'verification failure cleared group ownership');
    assert.equal(
      world.ledger()!.anchor_workspace_id,
      before.anchor_workspace_id,
      'verification failure cleared anchor ownership',
    );
    assert.equal(world.ledger()!.window_id, before.window_id, 'verification failure cleared window ownership');
    assert.deepEqual(world.ledger()!.trees, before.trees, 'verification failure dropped Tree ownership');
  } finally {
    world.cleanup();
  }
});

test('AC-34: a close cmux accepts but the workspace survives keeps that Tree owned, and a retry closes it', () => {
  const world = makeWorld();
  try {
    open(world);
    const before = world.ledger()!;
    const [survivorTree, survivorId] = Object.entries(before.trees).sort()[0]!;
    resetJournal(world);

    const first = runJson(world, ['close', world.root], { FAKE_CMUX_IGNORE_CLOSE: survivorId });
    assert.equal(first.code, 5, first.stdout + first.stderr);
    assert.equal(first.json.class, 'E_CMUX_TARGET');
    assert.equal(first.json.evidence.workspace_id, survivorId);
    assert.ok(world.state().workspaces[survivorId], 'the fake closed the survivor after all');
    assert.equal(world.ledger()!.trees[survivorTree], survivorId, 'the live survivor lost its ledger row');

    // cmux behaves again; the retry must find and close our own workspace, not call it foreign.
    const retry = runJson(world, ['close', world.root]);
    assert.equal(retry.code, 0, retry.stdout + retry.stderr);
    assert.equal(world.state().workspaces[survivorId], undefined, 'the retry left the survivor open');
    assert.deepEqual(world.ledger()!.trees, {});
    assert.ok(
      !(retry.json.warnings ?? []).some((w: string) => w.includes(survivorId)),
      `the retry reported our own workspace as foreign: ${JSON.stringify(retry.json.warnings)}`,
    );
  } finally {
    world.cleanup();
  }
});

test('AC-27: --forget is withheld when a ledgered workspace the first scan missed is live after close', () => {
  const world = makeWorld();
  try {
    open(world);
    const ledger = world.ledger()!;
    const [treeName, hiddenId] = Object.entries(ledger.trees)[0] as [string, string];
    resetJournal(world);

    // The workspace is absent from the pre-close scan and back for the verification scan.
    const result = runJson(world, ['close', world.root, '--forget'], {
      FAKE_CMUX_HIDE_WORKSPACE: hiddenId,
      FAKE_CMUX_HIDE_LIST_CALLS: '1',
    });
    assert.equal(result.code, 5, result.stderr);
    assert.equal(result.json.class, 'E_CMUX_TARGET');
    assert.equal(result.json.evidence.workspace_id, hiddenId);
    assert.equal(result.json.evidence.planned, false);
    assert.ok(world.state().workspaces[hiddenId], 'the reappeared workspace is live');
    assert.equal(existsSync(join(world.root, '.grove-cmux')), true, '--forget deleted the only ownership record');
    assert.equal(world.ledger()!.trees[treeName], hiddenId);
    assert.equal(world.ledger()!.group_id, ledger.group_id);

    const retry = runJson(world, ['close', world.root, '--forget']);
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(world.state().workspaces[hiddenId], undefined);
    assert.equal(existsSync(join(world.root, '.grove-cmux')), false);
  } finally {
    world.cleanup();
  }
});

test('AC-23: an owned group surviving with no foreign member withholds clearing and forgetting', () => {
  const world = makeWorld();
  try {
    open(world);
    const ledger = world.ledger()!;
    resetJournal(world);

    const plain = runJson(world, ['close', world.root], { FAKE_CMUX_KEEP_EMPTY_GROUPS: '1' });
    assert.equal(plain.code, 5, plain.stderr);
    assert.equal(plain.json.class, 'E_CMUX_TARGET');
    assert.equal(plain.json.evidence.group_id, ledger.group_id);
    assert.ok(world.state().groups[ledger.group_id], 'the owned group is still live');
    assert.equal(Object.keys(world.state().workspaces).length, 0);
    assert.equal(world.ledger()!.group_id, ledger.group_id, 'group ownership was cleared');

    const forget = runJson(world, ['close', world.root, '--forget'], {
      FAKE_CMUX_KEEP_EMPTY_GROUPS: '1',
    });
    assert.equal(forget.code, 5, forget.stderr);
    assert.equal(existsSync(join(world.root, '.grove-cmux')), true, '--forget removed the ledger');
    assert.equal(world.ledger()!.group_id, ledger.group_id);

    world.setState((state) => { delete state.groups[ledger.group_id]; });
    const retry = runJson(world, ['close', world.root, '--forget']);
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(existsSync(join(world.root, '.grove-cmux')), false);
  } finally {
    world.cleanup();
  }
});

test('close refuses targeting and passthrough options before mutation', () => {
  const world = makeWorld();
  try {
    open(world);
    for (const suffix of [
      ['--window', 'W1'],
      ['--relocate'],
      ['--', 'anything'],
    ]) {
      resetJournal(world);
      const result = runJson(world, ['close', world.root, ...suffix]);
      assert.equal(result.code, 2, `${suffix.join(' ')} was accepted`);
      assert.equal(result.json.class, 'E_USAGE');
      assert.deepEqual(mutatingCalls(world), []);
      if (suffix[0] === '--window') assert.match(result.json.remedy, /finds each ledgered workspace/);
    }
  } finally {
    world.cleanup();
  }
});

test('AC-25: closing one Grove in a shared window leaves the other projection byte-identical', () => {
  const first = makeWorld({ grove: 'first' });
  const second = makeWorld({ grove: 'second' });
  try {
    open(first);
    second.env.FAKE_CMUX_STATE = first.statePath;
    open(second);
    const secondLedger = second.ledger()!;
    const secondGroupBefore = JSON.stringify(first.state().groups[secondLedger.group_id]);
    const secondWorkspacesBefore = new Map(
      [...Object.values(secondLedger.trees), secondLedger.anchor_workspace_id]
        .map((id) => [id, JSON.stringify(first.state().workspaces[id])]),
    );
    const secondLedgerBefore = ledgerBytes(second);

    const result = runJson(first, ['close', first.root]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.stringify(first.state().groups[secondLedger.group_id]), secondGroupBefore);
    for (const [id, before] of secondWorkspacesBefore) {
      assert.equal(JSON.stringify(first.state().workspaces[id]), before);
    }
    assert.equal(ledgerBytes(second), secondLedgerBefore);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test('AC-30: a missing active root points to the matching archived ledger', () => {
  const world = makeWorld();
  try {
    const target = join(world.base, 'groves', 'archived-grove');
    const archivedAt = join(world.base, 'archives', 'archived-grove');
    const archivedLedger = join(archivedAt, '.grove-cmux', 'projection.json');
    mkdirSync(join(archivedAt, '.grove-cmux'), { recursive: true });
    writeFileSync(archivedLedger, JSON.stringify({ schema: 1, grove: 'archived-grove' }));
    world.setState((state) => { state.running = false; });

    const result = runJson(world, ['status', target]);
    assert.equal(result.code, 12);
    assert.equal(result.json.class, 'E_PRECONDITION');
    assert.equal(result.json.message, `the Grove root does not exist: ${target}`);
    assert.deepEqual(result.json.evidence, { grove_root: target, archived_at: archivedAt });
    assert.equal(
      result.json.remedy,
      `this Grove is archived; run grove-cmux against ${archivedAt}`,
    );
  } finally {
    world.cleanup();
  }
});

// The method set a build had to advertise before close existed, spelled out rather than
// imported: the point is that this historical set keeps working, whatever the constant says.
const PRE_CLOSE_METHODS = [
  'workspace.list',
  'workspace.create',
  'workspace.close',
  'workspace.group.list',
  'workspace.group.create',
  'workspace.group.add',
  'surface.create',
];

test('AC-31: a build offering only the pre-close methods still serves open, sync, status and close', () => {
  const world = makeWorld();
  try {
    world.setState((state) => {
      state.capabilities = PRE_CLOSE_METHODS;
      state.missing_methods = ['workspace.group.ungroup'];
    });
    for (const args of [
      ['open', world.root],
      ['status', world.root],
      ['sync', world.root],
      ['close', world.root],
    ]) {
      const result = runJson(world, args);
      assert.equal(result.code, 0, `${args[0]}: ${result.stderr}`);
    }
    assert.ok(!world.state().calls.some((call: { method: string }) =>
      call.method === 'workspace.group.ungroup',
    ));
    assert.equal(Object.keys(world.state().workspaces).length, 0);
  } finally {
    world.cleanup();
  }
});

// Further AC-31 coverage is the unchanged command cases in test/cli/commands.test.ts, the
// unchanged composition cases in test/integration/compose.test.ts, and the legacy envelope
// pinned by this negative AC-30 case.
test('AC-30: absent or invalid archive candidates preserve the literal missing-root refusal', () => {
  const world = makeWorld();
  try {
    const target = join(world.base, 'groves', 'no-such-grove');
    const archivedAt = join(world.base, 'archives', 'no-such-grove');
    const ledger = join(archivedAt, '.grove-cmux', 'projection.json');
    world.setState((state) => { state.running = false; });

    const assertLegacyRefusal = (label: string) => {
      const result = runJson(world, ['status', target]);
      assert.equal(result.code, 12, label);
      assert.deepEqual(result.json, {
        schema: 'grove-cmux.error/1',
        class: 'E_PRECONDITION',
        exit_code: 12,
        message: `the Grove root does not exist: ${target}`,
        evidence: { grove_root: target },
        remedy: 'check the path in the evidence exists and is a Grove',
      }, label);
    };

    assertLegacyRefusal('missing archive ledger');

    mkdirSync(join(archivedAt, '.grove-cmux'), { recursive: true });
    writeFileSync(ledger, '{ malformed json');
    assertLegacyRefusal('malformed archive ledger');

    rmSync(ledger);
    mkdirSync(ledger);
    assertLegacyRefusal('unreadable archive ledger');

    rmSync(ledger, { recursive: true });
    writeFileSync(ledger, JSON.stringify({ schema: 1, grove: 'different-grove' }));
    assertLegacyRefusal('archive ledger for a different Grove');
  } finally {
    world.cleanup();
  }
});
