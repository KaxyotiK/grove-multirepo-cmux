/**
 * The version a user is told and the version that was published must be the same number.
 *
 * `VERSION` is a literal in src/cli.ts and the tarball's version comes from package.json, so
 * nothing but this case ties them together. Without it `npm version` bumps one and leaves
 * `grove-cmux --version` quietly reporting the previous release — a lie that survives every
 * other test in the suite, because every other test reads the same literal it is checking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VERSION } from '../../src/cli.ts';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

test('VERSION in src/cli.ts equals the version in package.json', () => {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  assert.equal(
    VERSION,
    pkg.version,
    `src/cli.ts VERSION is "${VERSION}" but package.json says "${pkg.version}" — ` +
      'bump both, or --version reports the wrong release',
  );
});

test('the version is a plain semver triple, so --version output stays parsable', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
});
