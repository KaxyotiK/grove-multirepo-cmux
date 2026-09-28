import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CmuxClient } from '../../src/cmux.ts';
import { closeProjection } from '../../src/engine.ts';
import { isGroveCmuxError } from '../../src/errors.ts';
import { emptyLedger, ledgerPath, readLedger, writeLedger } from '../../src/ledger.ts';
import { FAKE_CMUX, makeWorld } from '../helpers/world.mjs';

const MUTATING = new Set([
  'workspace.create',
  'workspace.close',
  'workspace.group.create',
  'workspace.group.add',
  'workspace.group.ungroup',
  'surface.create',
]);

test('AC-27: a ledger EISDIR failure after close preserves ownership and a fresh retry completes', async () => {
  const world = makeWorld();
  const previousState = process.env.FAKE_CMUX_STATE;
  const obstruction = `${ledgerPath(world.root)}.${process.pid}.tmp`;
  const firstClient = new CmuxClient({ bin: FAKE_CMUX });
  const originalClose = firstClient.closeWorkspace;

  try {
    const [firstTree, secondTree] = world.treeNames;
    assert.ok(firstTree && secondTree);
    const ledger = {
      ...emptyLedger(world.grove),
      cmux_build: '102',
      window_id: 'W1',
      group_id: 'G1',
      anchor_workspace_id: 'anchor',
      trees: { [firstTree]: 'tree-1', [secondTree]: 'tree-2' },
    };
    writeLedger(world.root, ledger);
    world.setState((state) => {
      state.workspaces = {
        'tree-1': {
          id: 'tree-1', window_id: 'W1', title: 'api', current_directory: world.treePaths[firstTree],
        },
        'tree-2': {
          id: 'tree-2', window_id: 'W1', title: 'web', current_directory: world.treePaths[secondTree],
        },
        anchor: {
          id: 'anchor', window_id: 'W1', title: world.grove, current_directory: world.root,
        },
      };
      state.groups = {
        G1: {
          id: 'G1',
          window_id: 'W1',
          name: world.grove,
          anchor_workspace_id: 'anchor',
          member_workspace_ids: ['anchor', 'tree-1', 'tree-2'],
        },
      };
      state.calls = [];
      state.mutations = 0;
    });
    process.env.FAKE_CMUX_STATE = world.statePath;

    let intercepted = false;
    firstClient.closeWorkspace = async (workspaceId: string, windowId: string) => {
      await originalClose.call(firstClient, workspaceId, windowId);
      if (!intercepted) {
        intercepted = true;
        mkdirSync(obstruction);
      }
    };

    await assert.rejects(
      closeProjection({ groveRoot: world.root, client: firstClient, forget: true }),
      (error: unknown) => {
        assert.ok(isGroveCmuxError(error));
        assert.equal(error.cls, 'E_LEDGER');
        assert.equal(error.code, 10);
        assert.match(String(error.evidence.cause), /EISDIR|directory/i);
        return true;
      },
    );

    assert.equal(world.state().workspaces['tree-1'], undefined, 'the close did not take effect');
    const mutations = world.state().calls.filter((call: { method: string }) => MUTATING.has(call.method));
    assert.deepEqual(mutations.map((call: { method: string }) => call.method), ['workspace.close']);
    assert.equal(existsSync(join(world.root, '.grove-cmux')), true, '--forget removed recovery state');

    const retained = readLedger(world.root)!;
    const retainedIds = new Set([
      ...Object.values(retained.trees),
      retained.anchor_workspace_id,
    ]);
    for (const id of Object.keys(world.state().workspaces)) {
      assert.ok(retainedIds.has(id), `live workspace ${id} is absent from the retained ledger`);
    }

    rmSync(obstruction, { recursive: true });
    firstClient.closeWorkspace = originalClose;
    const freshClient = new CmuxClient({ bin: FAKE_CMUX });
    const retry = await closeProjection({ groveRoot: world.root, client: freshClient, forget: true });
    assert.equal(retry.applied?.filter((action) => action.op === 'workspace.close').length, 2);
    assert.deepEqual(world.state().workspaces, {});
    assert.equal(existsSync(join(world.root, '.grove-cmux')), false);
  } finally {
    firstClient.closeWorkspace = originalClose;
    rmSync(obstruction, { recursive: true, force: true });
    if (previousState === undefined) delete process.env.FAKE_CMUX_STATE;
    else process.env.FAKE_CMUX_STATE = previousState;
    world.cleanup();
  }
});
