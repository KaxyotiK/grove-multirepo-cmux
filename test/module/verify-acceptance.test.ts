import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatAcceptanceRecord,
  inspectAcceptanceRecord,
} from '../../scripts/verify-acceptance.mjs';

const criterion = (number: number) => `AC-${String(number).padStart(2, '0')}`;

function withFixture(record: string[] | null, tests: string[], check: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'grove-cmux-acceptance-'));
  try {
    mkdirSync(join(root, 'test'));
    if (record) {
      const body = record.map((id) => `- **${id}:** criterion`).join('\n');
      writeFileSync(join(root, 'test', 'ACCEPTANCE.md'), `# Acceptance criteria\n\n${body}\n`);
    }
    writeFileSync(join(root, 'test', 'coverage.test.ts'), tests.join('\n'));
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a record whose every criterion is named by a test passes', () => {
  const id = criterion(1);
  withFixture([id], [`test('${id}: covered', () => {});`], (root) => {
    const result = inspectAcceptanceRecord(root);
    assert.equal(result.exitCode, 0);
    assert.match(formatAcceptanceRecord(result).stdout, /authoritative and total/);
  });
});

test('a declared criterion no test names is fatal', () => {
  const id = criterion(2);
  withFixture([id], [], (root) => {
    const result = inspectAcceptanceRecord(root);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.uncovered, [id]);
    assert.match(formatAcceptanceRecord(result).stderr, /no test names/);
  });
});

test('a test naming an undeclared criterion is fatal', () => {
  const declared = criterion(3);
  const unknown = criterion(4);
  withFixture([declared], [`test('${declared}: a', () => {});`, `test('${unknown}: b', () => {});`], (root) => {
    const result = inspectAcceptanceRecord(root);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.undeclared, [unknown]);
  });
});

test('a criterion declared twice is fatal', () => {
  const id = criterion(5);
  withFixture([id, id], [`test('${id}: covered', () => {});`], (root) => {
    const result = inspectAcceptanceRecord(root);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.duplicates, [id]);
  });
});

test('a missing record is a configuration error, not a pass', () => {
  withFixture(null, [], (root) => {
    const result = inspectAcceptanceRecord(root);
    assert.equal(result.exitCode, 2);
    assert.match(formatAcceptanceRecord(result).stderr, /missing acceptance record/);
  });
});
