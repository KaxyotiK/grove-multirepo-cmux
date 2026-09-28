import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGroveInstall, groveRequest } from '../helpers/guest.mjs';

/** A real npm-shaped tarball holding only package/package.json. */
function withTarball(pkg: object, check: (path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'grove-cmux-tarball-'));
  try {
    mkdirSync(join(root, 'package'));
    writeFileSync(join(root, 'package', 'package.json'), JSON.stringify(pkg));
    const path = join(root, 'pkg.tgz');
    execFileSync('tar', ['-czf', path, '-C', root, 'package']);
    check(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const BIN = '/opt/homebrew/lib/node_modules/grove-multirepo/dist/grove.mjs';

function report(fields: Record<string, unknown>) {
  const r = {
    npm_ls_version: '0.1.1',
    package_bin: BIN,
    command_v: BIN,
    login_command_v: BIN,
    grove_version: '0.1.1',
    ...fields,
  };
  return `GROVE_INSTALL ${JSON.stringify(r)}\n`;
}

const request = { path: '/tmp/x.tgz', version: '0.1.1', sha256: 'x' };

test('AC-35: with no tarball the run refuses and says how to make one', () => {
  assert.throws(
    () => groveRequest({}),
    /GROVE_CMUX_GROVE_TARBALL is not set.*npm pack.*grove-multirepo checkout/s,
  );
});

test('AC-35: GROVE_CMUX_GROVE_TARBALL requests the version inside that tarball, with its sha256', () => {
  withTarball({ name: 'grove-multirepo', version: '0.1.1' }, (path) => {
    assert.deepEqual(groveRequest({ GROVE_CMUX_GROVE_TARBALL: path }), {
      path,
      version: '0.1.1',
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    });
  });
});

test('AC-35: a tarball of any other package, or an unreadable file, is refused', () => {
  withTarball({ name: 'some-other-grove', version: '0.3.0' }, (path) => {
    assert.throws(
      () => groveRequest({ GROVE_CMUX_GROVE_TARBALL: path }),
      /holds some-other-grove@0\.3\.0, not grove-multirepo/,
    );
  });
  assert.throws(
    () => groveRequest({ GROVE_CMUX_GROVE_TARBALL: '/nonexistent/grove.tgz' }),
    /not a readable npm tarball/,
  );
});

test('AC-35: an install matching the tarball passes', () => {
  assert.equal(checkGroveInstall(request, report({})).version, '0.1.1');
});

test('AC-35: any mismatch with the tarball fails the run', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ npm_ls_version: null }, /npm ls -g shows grove-multirepo@nothing/],
    [{ npm_ls_version: '0.1.0', grove_version: '0.1.0' }, /npm ls -g shows grove-multirepo@0\.1\.0, not 0\.1\.1/],
    [{ grove_version: '0.3.0' }, /grove --version prints 0\.3\.0/],
    [{ command_v: '/usr/local/bin/grove' }, /command -v grove resolves to \/usr\/local\/bin\/grove/],
    [{ login_command_v: '/Users/admin/.local/bin/grove' }, /login shell's command -v grove resolves to/],
    [{ package_bin: null, command_v: null, login_command_v: null }, /has no grove bin/],
  ];
  for (const [fields, message] of cases) {
    assert.throws(() => checkGroveInstall(request, report(fields)), message);
  }
});

test('AC-35: a guest that produced no install report fails the run with its output', () => {
  assert.throws(() => checkGroveInstall(request, 'npm error code ENOENT\n'), /npm error code ENOENT/);
});
