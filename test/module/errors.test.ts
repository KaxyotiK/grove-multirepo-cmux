import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CLASSES, GroveCmuxError, type ErrorClass } from '../../src/errors.ts';
import { classifyExecFailure, classifyRpcError, parseVersion } from '../../src/cmux.ts';

const CLASSES = Object.keys(ERROR_CLASSES) as ErrorClass[];

test('every class has a non-empty remedy — a class with none is incomplete', () => {
  for (const c of CLASSES) {
    assert.ok(ERROR_CLASSES[c].remedy.length > 0, `${c} has no remedy`);
    assert.ok(ERROR_CLASSES[c].meaning.length > 0, `${c} has no meaning`);
  }
});

test('exit codes are unique, contiguous from 1, and 13 classes exist', () => {
  const codes = CLASSES.map((c) => ERROR_CLASSES[c].code).sort((a, b) => a - b);
  assert.deepEqual(codes, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test('the codes are the ones the converge fixed, so a renumber fails here', () => {
  assert.equal(ERROR_CLASSES.E_INTERNAL.code, 1);
  assert.equal(ERROR_CLASSES.E_USAGE.code, 2);
  assert.equal(ERROR_CLASSES.E_CMUX_UNAVAILABLE.code, 3);
  assert.equal(ERROR_CLASSES.E_CMUX_AUTH.code, 4);
  assert.equal(ERROR_CLASSES.E_CMUX_TARGET.code, 5);
  assert.equal(ERROR_CLASSES.E_CMUX_RPC.code, 6);
  assert.equal(ERROR_CLASSES.E_CMUX_INCOMPATIBLE.code, 7);
  assert.equal(ERROR_CLASSES.E_GROVE_FAILED.code, 8);
  assert.equal(ERROR_CLASSES.E_GROVE_SCHEMA.code, 9);
  assert.equal(ERROR_CLASSES.E_LEDGER.code, 10);
  assert.equal(ERROR_CLASSES.E_AMBIGUOUS_TARGET.code, 11);
  assert.equal(ERROR_CLASSES.E_PRECONDITION.code, 12);
  assert.equal(ERROR_CLASSES.E_PROJECTION_CONFLICT.code, 13);
});

test('the human envelope is class line, evidence, remedy — AC-13 exactly', () => {
  const e = new GroveCmuxError('E_CMUX_AUTH', 'cmux rejected the socket password', {
    method: 'workspace.list',
    window_id: 'W1',
  });
  const lines = e.toHuman().split('\n');
  assert.equal(lines[0], 'error: E_CMUX_AUTH (4): cmux rejected the socket password');
  assert.equal(lines[1], 'evidence:');
  assert.ok(lines.some((l) => l.startsWith('  method: workspace.list')));
  assert.ok(lines.at(-1)!.startsWith('try: '));
});

test('the JSON envelope carries class, exit_code, evidence and remedy', () => {
  const j = new GroveCmuxError('E_LEDGER', 'bad', { path: '/x' }).toJSON();
  assert.equal(j.schema, 'grove-cmux.error/1');
  assert.equal(j.class, 'E_LEDGER');
  assert.equal(j.exit_code, 10);
  assert.deepEqual(j.evidence, { path: '/x' });
  assert.ok(j.remedy.length > 0);
});

// The live strings, each mapped to the class the converge assigned it.
const RPC_CASES: Array<[string, ErrorClass]> = [
  ['TabManager not available', 'E_CMUX_TARGET'],
  ['Group not found', 'E_CMUX_TARGET'],
  ['unauthorized', 'E_CMUX_AUTH'],
  ['unknown method workspace.frobnicate', 'E_CMUX_INCOMPATIBLE'],
  ['something else entirely', 'E_CMUX_RPC'],
];

for (const [message, cls] of RPC_CASES) {
  test(`an RPC error saying "${message}" classifies as ${cls}`, () => {
    const e = classifyRpcError({ message }, 'workspace.list', {});
    assert.equal(e.cls, cls);
    assert.equal(e.evidence.rpc_error, message);
  });
}

test('an unavailable window and a foreign group share E_CMUX_TARGET but keep their raw strings', () => {
  const a = classifyRpcError({ code: 'unavailable', message: 'TabManager not available' }, 'workspace.list', {});
  const b = classifyRpcError({ code: 'not_found', message: 'Group not found' }, 'workspace.group.add', {});
  assert.equal(a.cls, b.cls);
  assert.notEqual(a.evidence.rpc_error, b.evidence.rpc_error);
});

test('a missing cmux binary is E_CMUX_UNAVAILABLE with an install remedy', () => {
  const e = classifyExecFailure({ code: 'ENOENT' }, 'version', {}, 'cmux');
  assert.equal(e.cls, 'E_CMUX_UNAVAILABLE');
  assert.match(e.remedy, /install cmux/);
});

test('a refused socket is E_CMUX_UNAVAILABLE, and a rejected password is E_CMUX_AUTH', () => {
  assert.equal(
    classifyExecFailure({ code: 1, stderr: 'connection refused' }, 'rpc', {}, 'cmux').cls,
    'E_CMUX_UNAVAILABLE',
  );
  assert.equal(
    classifyExecFailure({ code: 1, stderr: 'unauthorized: socket password rejected' }, 'rpc', {}, 'cmux').cls,
    'E_CMUX_AUTH',
  );
});

test('a JSON error body on stdout is classified as RPC, not as a transport failure', () => {
  const e = classifyExecFailure(
    { code: 1, stdout: JSON.stringify({ error: { code: 'not_found', message: 'Group not found' } }) },
    'workspace.group.add',
    {},
    'cmux',
  );
  assert.equal(e.cls, 'E_CMUX_TARGET');
});

test('the version parser reads build and hash whether or not the program name leads', () => {
  // The live build prints "cmux 0.64.22 (102) [ddd4a01bc]". Taking the first token gave
  // "cmux", which made build null and silently disabled the minimum-build check.
  for (const raw of ['cmux 0.64.22 (102) [ddd4a01bc]', '0.64.22 (102) [ddd4a01bc]']) {
    const v = parseVersion(raw);
    assert.equal(v.version, '0.64.22', raw);
    assert.equal(v.build, '102', raw);
    assert.equal(v.hash, 'ddd4a01bc', raw);
    assert.equal(v.raw, raw);
  }
});

test('a version string with no build or hash still yields the version, not the program name', () => {
  const v = parseVersion('cmux 1.2.3');
  assert.equal(v.version, '1.2.3');
  assert.equal(v.build, null);
});
