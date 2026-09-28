import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fakeCmux = join(dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'fake-cmux.mjs');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'grove-cmux-fake-lifecycle-'));
  const statePath = join(directory, 'state.json');
  const workspaces = {
    anchor: { id: 'anchor', window_id: 'W1' },
    member1: { id: 'member1', window_id: 'W1' },
    member2: { id: 'member2', window_id: 'W1' },
  };
  writeFileSync(
    statePath,
    JSON.stringify({
      version: '0.64.22 (102) [ddd4a01bc]',
      capabilities: null,
      windows: [{ id: 'W1', title: 'window one' }],
      workspaces,
      groups: {},
      mutations: 0,
      calls: [],
      password: null,
      running: true,
    }),
  );
  return {
    statePath,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function rpc(statePath: string, method: string, params: Record<string, string>) {
  const output = execFileSync(process.execPath, [fakeCmux, 'rpc', method, JSON.stringify(params)], {
    env: { ...process.env, FAKE_CMUX_STATE: statePath },
    encoding: 'utf8',
  });
  return JSON.parse(output).result;
}

test('AC-22: closing the last workspace removes its group from workspace.group.list', () => {
  const world = fixture();
  try {
    const state = JSON.parse(readFileSync(world.statePath, 'utf8'));
    delete state.workspaces.member1;
    delete state.workspaces.member2;
    state.groups.G1 = {
      id: 'G1',
      window_id: 'W1',
      name: 'one workspace',
      anchor_workspace_id: 'anchor',
      member_workspace_ids: ['anchor'],
    };
    writeFileSync(world.statePath, JSON.stringify(state));

    rpc(world.statePath, 'workspace.close', { window_id: 'W1', workspace_id: 'anchor' });
    const listed = rpc(world.statePath, 'workspace.group.list', { window_id: 'W1' });
    assert.deepEqual(listed.groups, []);
  } finally {
    world.cleanup();
  }
});

test('AC-22: closing an anchor promotes a surviving member', () => {
  const world = fixture();
  try {
    const state = JSON.parse(readFileSync(world.statePath, 'utf8'));
    state.groups.G1 = {
      id: 'G1',
      window_id: 'W1',
      name: 'three workspaces',
      anchor_workspace_id: 'anchor',
      member_workspace_ids: ['anchor', 'member1', 'member2'],
    };
    writeFileSync(world.statePath, JSON.stringify(state));

    rpc(world.statePath, 'workspace.close', { window_id: 'W1', workspace_id: 'anchor' });
    const listed = rpc(world.statePath, 'workspace.group.list', { window_id: 'W1' });
    assert.equal(listed.groups.length, 1);
    assert.equal(listed.groups[0].anchor_workspace_id, 'member1');
    assert.deepEqual(listed.groups[0].member_workspace_ids, ['member1', 'member2']);
  } finally {
    world.cleanup();
  }
});

function rpcFailure(statePath: string, method: string, params: Record<string, string>) {
  const result = spawnSync(process.execPath, [fakeCmux, 'rpc', method, JSON.stringify(params)], {
    env: { ...process.env, FAKE_CMUX_STATE: statePath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, `${method} unexpectedly succeeded`);
  return JSON.parse(result.stdout).error;
}

function twoWindows(world: ReturnType<typeof fixture>) {
  const state = JSON.parse(readFileSync(world.statePath, 'utf8'));
  state.windows.push({ id: 'W2', title: 'window two' });
  state.workspaces.member2.window_id = 'W2';
  state.groups.G2 = {
    id: 'G2',
    window_id: 'W2',
    name: 'second window',
    anchor_workspace_id: 'member2',
    member_workspace_ids: ['member2'],
  };
  writeFileSync(world.statePath, JSON.stringify(state));
  return readFileSync(world.statePath, 'utf8');
}

test('fake cmux: workspace.close through a window that does not hold it is not_found and mutates nothing', () => {
  const world = fixture();
  try {
    twoWindows(world);
    const before = JSON.parse(readFileSync(world.statePath, 'utf8'));
    const error = rpcFailure(world.statePath, 'workspace.close', {
      window_id: 'W1',
      workspace_id: 'member2',
    });
    assert.equal(error.code, 'not_found');
    assert.match(error.message, /Workspace not found/);
    const after = JSON.parse(readFileSync(world.statePath, 'utf8'));
    assert.deepEqual(after.workspaces, before.workspaces);
    assert.deepEqual(after.groups, before.groups);
  } finally {
    world.cleanup();
  }
});

test('fake cmux: workspace.group.ungroup through a window that does not hold the group is not_found', () => {
  const world = fixture();
  try {
    twoWindows(world);
    const before = JSON.parse(readFileSync(world.statePath, 'utf8'));
    const error = rpcFailure(world.statePath, 'workspace.group.ungroup', {
      window_id: 'W1',
      group_id: 'G2',
    });
    assert.equal(error.code, 'not_found');
    assert.match(error.message, /Group not found/);
    assert.deepEqual(JSON.parse(readFileSync(world.statePath, 'utf8')).groups, before.groups);
  } finally {
    world.cleanup();
  }
});
