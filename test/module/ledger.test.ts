import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyLedger,
  LEDGER_SCHEMA,
  LedgerWriter,
  ledgerPath,
  readLedger,
  writeLedger,
} from '../../src/ledger.ts';
import { isGroveCmuxError } from '../../src/errors.ts';

function root() {
  return mkdtempSync(join(tmpdir(), 'grove-cmux-ledger-'));
}

test('an absent ledger reads as null rather than throwing', () => {
  assert.equal(readLedger(root()), null);
});

test('a written ledger round-trips', () => {
  const r = root();
  const l = emptyLedger('g');
  l.trees['g@api'] = 'ws1';
  l.group_id = 'G1';
  writeLedger(r, l);
  assert.deepEqual(readLedger(r), l);
});

test('the write is atomic: no temp file survives, and the target is complete', () => {
  const r = root();
  writeLedger(r, emptyLedger('g'));
  const dir = join(r, '.grove-cmux');
  assert.deepEqual(readdirSync(dir), ['projection.json']);
  JSON.parse(readFileSync(ledgerPath(r), 'utf8'));
});

test('a ledger from a newer schema refuses with E_LEDGER and never says to delete it', () => {
  const r = root();
  mkdirSync(join(r, '.grove-cmux'), { recursive: true });
  writeFileSync(ledgerPath(r), JSON.stringify({ schema: LEDGER_SCHEMA + 1 }));
  try {
    readLedger(r);
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(isGroveCmuxError(e));
    assert.equal(e.cls, 'E_LEDGER');
    assert.equal(e.code, 10);
    assert.match(e.remedy, /do not delete the ledger/);
  }
});

test('an unparsable ledger refuses rather than silently starting fresh', () => {
  const r = root();
  mkdirSync(join(r, '.grove-cmux'), { recursive: true });
  writeFileSync(ledgerPath(r), '{ not json');
  try {
    readLedger(r);
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(isGroveCmuxError(e));
    assert.equal(e.cls, 'E_LEDGER');
  }
});

test('the writer persists after every single create, not once at the end', () => {
  const r = root();
  const w = new LedgerWriter(r, emptyLedger('g'));
  w.recordTree('g@api', 'ws1');
  // A crash here must leave the ledger already naming ws1.
  assert.deepEqual(readLedger(r)!.trees, { 'g@api': 'ws1' });
  w.recordTree('g@web', 'ws2');
  assert.deepEqual(readLedger(r)!.trees, { 'g@api': 'ws1', 'g@web': 'ws2' });
  assert.equal(w.writes.length, 2);
  // Each persisted state is a prefix of the next: the ledger never runs ahead of cmux.
  assert.deepEqual(Object.keys(w.writes[0]!.trees), ['g@api']);
  assert.deepEqual(Object.keys(w.writes[1]!.trees), ['g@api', 'g@web']);
});

test('dropping a tree persists immediately too', () => {
  const r = root();
  const w = new LedgerWriter(r, emptyLedger('g'));
  w.recordTree('g@api', 'ws1');
  w.dropTree('g@api');
  assert.deepEqual(readLedger(r)!.trees, {});
});

test('clearProjection releases every cmux object while retaining ledger provenance', () => {
  const r = root();
  const before = {
    ...emptyLedger('g'),
    cmux_build: '102',
    window_id: 'W1',
    group_id: 'G1',
    anchor_workspace_id: 'anchor',
    trees: { 'g@api': 'ws1' },
  };
  const writer = new LedgerWriter(r, before);
  writer.clearProjection();
  assert.deepEqual(readLedger(r), {
    ...emptyLedger('g'),
    cmux_build: '102',
  });
});

test('the recorded build is provenance, not a lock: rewriting it is a plain write', () => {
  const r = root();
  const w = new LedgerWriter(r, { ...emptyLedger('g'), cmux_build: '101' });
  w.recordBuild('103');
  assert.equal(readLedger(r)!.cmux_build, '103');
});
