import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnumerateAllWindows, resolveWindow } from '../../src/window.ts';
import { isGroveCmuxError } from '../../src/errors.ts';
import { emptyLedger, type Ledger } from '../../src/ledger.ts';
import type { CmuxClient, CmuxWindow, CmuxWorkspace } from '../../src/cmux.ts';

function fakeClient(windows: CmuxWindow[], workspaces: Record<string, CmuxWorkspace[]> = {}) {
  return {
    listWindows: async () => windows,
    listWorkspaces: async (id: string) => workspaces[id] ?? [],
  } as unknown as CmuxClient;
}

const none = async () => ({ caller: null, focused: null });

test('rule 1: --window wins, and reports source "flag"', async () => {
  const r = await resolveWindow({
    client: fakeClient([{ id: 'W1' }, { id: 'W2' }]),
    flag: 'W2',
    mutating: true,
    identify: none,
  });
  assert.deepEqual(r, { id: 'W2', source: 'flag' });
});

test('--window naming a window that does not exist is E_CMUX_TARGET, listing the real ones', async () => {
  try {
    await resolveWindow({
      client: fakeClient([{ id: 'W1' }]),
      flag: 'W9',
      mutating: true,
      identify: none,
    });
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(isGroveCmuxError(e));
    assert.equal(e.cls, 'E_CMUX_TARGET');
    assert.deepEqual(e.evidence.windows, ['W1']);
  }
});

test('rule 2: the focused fallback exists only under the person’s own signature', async () => {
  const r = await resolveWindow({
    client: fakeClient([{ id: 'W1' }, { id: 'W2' }]),
    flag: 'focused',
    mutating: true,
    identify: async () => ({ caller: null, focused: 'W2' }),
  });
  assert.deepEqual(r, { id: 'W2', source: 'focused' });
});

test('GROVE_CMUX_WINDOW=focused is the same opt-in, read from the environment', async () => {
  const prev = process.env.GROVE_CMUX_WINDOW;
  process.env.GROVE_CMUX_WINDOW = 'focused';
  try {
    const r = await resolveWindow({
      client: fakeClient([{ id: 'W1' }, { id: 'W2' }]),
      mutating: true,
      identify: async () => ({ caller: null, focused: 'W1' }),
    });
    assert.equal(r.source, 'focused');
  } finally {
    if (prev === undefined) delete process.env.GROVE_CMUX_WINDOW;
    else process.env.GROVE_CMUX_WINDOW = prev;
  }
});

test('rule 3: caller context is used when cmux supplies one', async () => {
  const r = await resolveWindow({
    client: fakeClient([{ id: 'W1' }, { id: 'W2' }]),
    mutating: true,
    identify: async () => ({ caller: 'W1', focused: 'W2' }),
  });
  assert.deepEqual(r, { id: 'W1', source: 'caller' });
});

test('rule 4: the ledger window is used only after our UUIDs are found in it', async () => {
  const ledger: Ledger = { ...emptyLedger('g'), window_id: 'W2', trees: { 'g@api': 'ws1' } };
  const r = await resolveWindow({
    client: fakeClient([{ id: 'W1' }, { id: 'W2' }], { W2: [{ id: 'ws1' }] }),
    ledger,
    mutating: true,
    identify: none,
  });
  assert.deepEqual(r, { id: 'W2', source: 'ledger' });
});

test('rule 4: a ledger window holding none of our UUIDs is not trusted', async () => {
  const ledger: Ledger = { ...emptyLedger('g'), window_id: 'W2', trees: { 'g@api': 'ws1' } };
  try {
    await resolveWindow({
      client: fakeClient([{ id: 'W1' }, { id: 'W2' }], { W2: [{ id: 'someoneElse' }] }),
      ledger,
      mutating: true,
      identify: none,
    });
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(isGroveCmuxError(e));
    assert.equal(e.cls, 'E_AMBIGUOUS_TARGET');
  }
});

test('rule 5: a single window is the only satisfying assignment, so it is not a guess', async () => {
  const r = await resolveWindow({
    client: fakeClient([{ id: 'W1' }]),
    mutating: true,
    identify: none,
  });
  assert.deepEqual(r, { id: 'W1', source: 'sole-window' });
});

test('rule 6: a mutation with two windows and nothing naming one refuses, listing both', async () => {
  try {
    await resolveWindow({
      client: fakeClient([{ id: 'W1', title: 'one' }, { id: 'W2', title: 'two' }]),
      mutating: true,
      identify: none,
    });
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(isGroveCmuxError(e));
    assert.equal(e.cls, 'E_AMBIGUOUS_TARGET');
    assert.equal(e.code, 11);
    assert.match(e.remedy, /--window/);
    assert.deepEqual(e.evidence.windows, [
      { id: 'W1', title: 'one' },
      { id: 'W2', title: 'two' },
    ]);
  }
});

test('rule 6: a read never refuses, it asks to enumerate every window', async () => {
  try {
    await resolveWindow({
      client: fakeClient([{ id: 'W1' }, { id: 'W2' }]),
      mutating: false,
      identify: none,
    });
    assert.fail('expected the enumerate signal');
  } catch (e) {
    assert.ok(e instanceof EnumerateAllWindows);
    assert.deepEqual(e.windows.map((w) => w.id), ['W1', 'W2']);
  }
});

test('rule 3: a verified ledger window outranks ambient caller context', async () => {
  // An agent running in a cmux terminal in W2, asking about a Grove projected in W1, used to
  // be told with exit 0 that every Tree was missing: caller won, W2 was observed, and nothing
  // of ours was in it. The ledger is evidence about this Grove; the caller is only where the
  // process happens to be typing.
  const ledger: Ledger = { ...emptyLedger('g'), window_id: 'W1', trees: { 'g@api': 'ws1' } };
  const r = await resolveWindow({
    client: fakeClient([{ id: 'W1' }, { id: 'W2' }], { W1: [{ id: 'ws1' }] }),
    ledger,
    mutating: false,
    identify: async () => ({ caller: 'W2', focused: 'W2' }),
  });
  assert.deepEqual(r, { id: 'W1', source: 'ledger' });
});

test('an unverifiable ledger window still yields to caller context', async () => {
  // The ledger only outranks the caller when it is actually verified. A window that no longer
  // holds any of our UUIDs is a stale hint, and a stale hint must not beat a live signal.
  const ledger: Ledger = { ...emptyLedger('g'), window_id: 'W1', trees: { 'g@api': 'ws1' } };
  const r = await resolveWindow({
    client: fakeClient([{ id: 'W1' }, { id: 'W2' }], { W1: [{ id: 'someoneElse' }] }),
    ledger,
    mutating: false,
    identify: async () => ({ caller: 'W2', focused: 'W2' }),
  });
  assert.deepEqual(r, { id: 'W2', source: 'caller' });
});

test('--relocate skips the ledger entirely, because "here" is the whole point', async () => {
  const ledger: Ledger = { ...emptyLedger('g'), window_id: 'W1', trees: { 'g@api': 'ws1' } };
  const r = await resolveWindow({
    client: fakeClient([{ id: 'W1' }, { id: 'W2' }], { W1: [{ id: 'ws1' }] }),
    ledger,
    mutating: true,
    relocate: true,
    identify: async () => ({ caller: 'W2', focused: 'W2' }),
  });
  assert.deepEqual(r, { id: 'W2', source: 'caller' });
});
