/**
 * The seams grove-cmux does not own: the grove binary, agent launch, the surfaces it must
 * never touch, and the packaged artefact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorld, run, runJson } from '../helpers/world.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A fake grove that emits the documented envelope and creates the Grove on disk. */
function fakeGrove(
  world: ReturnType<typeof makeWorld>,
  opts: { outcome?: string; schemaVersion?: number; recordArgv?: string } = {},
) {
  const bin = join(world.base, 'fake-grove');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
${opts.recordArgv ? `writeFileSync(${JSON.stringify(opts.recordArgv)}, JSON.stringify(argv));` : ''}
const name = argv[argv.indexOf('new') + 1];
const root = join(${JSON.stringify(world.base)}, 'groves', name);
const outcome = ${JSON.stringify(opts.outcome ?? 'complete')};
const trees = [name + '@one', name + '@two'];
if (outcome === 'complete') {
  for (const t of trees) mkdirSync(join(root, 'trees', t), { recursive: true });
}
// The real shape, copied from a live \`grove --json new\`: outcome is "complete", and targets
// is an ARRAY of per-Tree records whose selector.path names the Tree, not an object with a
// root. A fake that agreed with the author's assumption hid two bugs.
process.stdout.write(JSON.stringify({
  schemaVersion: ${opts.schemaVersion ?? 1},
  command: 'new',
  outcome,
  operationId: '01TESTTESTTESTTESTTESTTEST',
  targets: trees.map((t) => ({
    selector: {
      repositoryId: '01REPO' + t,
      repositoryAlias: t.split('@')[1],
      grove: name,
      tree: t,
      path: join(root, 'trees', t),
    },
    action: 'worktree-add',
    after: { path: join(root, 'trees', t), branch: name },
    reason: null,
  })),
  diagnostics: [],
  detail: { grove: name },
}));
`,
    { mode: 0o755 },
  );
  return bin;
}

test('AC-11: new forwards to grove --json and projects a complete outcome', () => {
  const w = makeWorld({ trees: [] });
  try {
    const bin = fakeGrove(w);
    const r = runJson(w, ['new', 'shipit'], { GROVE_BIN: bin });
    assert.equal(r.code, 0, r.stderr);
    // Two Trees the fake grove made, plus the anchor its group brought.
    assert.equal(r.json.summary.present, 2);
    assert.equal(r.json.group.state, 'present');
    assert.equal(Object.keys(w.state().groups).length, 1);
    // The Grove root came from a Tree path, not from <cwd>/<name>.
    assert.equal(r.json.grove.root, join(w.base, 'groves', 'shipit'));
  } finally {
    w.cleanup();
  }
});

test('AC-11: new forwards a grove flag and its separate value together, in order', () => {
  const w = makeWorld({ trees: [] });
  try {
    const argvFile = join(w.base, 'grove-argv.json');
    const bin = fakeGrove(w, { recordArgv: argvFile });
    const r = runJson(
      w,
      ['new', 'shipit', '--repo', 'one', '--branch', 'one=feat', '--from=two=main', '--all'],
      { GROVE_BIN: bin },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(argvFile, 'utf8')), [
      '--json', 'new', 'shipit', '--repo', 'one', '--branch', 'one=feat', '--from=two=main', '--all',
    ]);
  } finally {
    w.cleanup();
  }
});

test('AC-11: a partial grove outcome projects nothing and refuses E_GROVE_FAILED', () => {
  const w = makeWorld({ trees: [] });
  try {
    const bin = fakeGrove(w, { outcome: 'partial' });
    const r = runJson(w, ['new', 'halfdone'], { GROVE_BIN: bin });
    assert.equal(r.code, 8);
    assert.equal(r.json.class, 'E_GROVE_FAILED');
    assert.match(r.json.message, /partial/);
    assert.equal(Object.keys(w.state().workspaces).length, 0, 'a partial outcome was projected');
  } finally {
    w.cleanup();
  }
});

test('AC-11: an unrecognised grove schemaVersion refuses E_GROVE_SCHEMA (9)', () => {
  const w = makeWorld({ trees: [] });
  try {
    const bin = fakeGrove(w, { schemaVersion: 99 });
    const r = runJson(w, ['new', 'future'], { GROVE_BIN: bin });
    assert.equal(r.code, 9);
    assert.equal(r.json.class, 'E_GROVE_SCHEMA');
    assert.equal(r.json.evidence.schemaVersion, 99);
  } finally {
    w.cleanup();
  }
});

test('AC-11: a grove that exits non-zero refuses E_GROVE_FAILED with its stderr', () => {
  const w = makeWorld({ trees: [] });
  try {
    const bin = join(w.base, 'angry-grove');
    writeFileSync(bin, '#!/bin/sh\necho "worktree is dirty" >&2\nexit 3\n', { mode: 0o755 });
    const r = runJson(w, ['new', 'nope'], { GROVE_BIN: bin });
    assert.equal(r.code, 8);
    assert.equal(r.json.evidence.exit_code, 3);
    assert.match(String(r.json.evidence.stderr), /worktree is dirty/);
  } finally {
    w.cleanup();
  }
});

test('AC-12: an agent launches only when asked, in its own Tree, as part of the create', () => {
  const w = makeWorld();
  try {
    const plain = makeWorld();
    run(plain, ['open', plain.root]);
    for (const ws of Object.values(plain.state().workspaces) as Array<Record<string, unknown>>) {
      assert.ok(!ws.initial_command, 'an agent started without being requested');
    }
    plain.cleanup();

    const r = runJson(w, ['open', w.root, '--agent', 'claude']);
    assert.equal(r.code, 0, r.stderr);
    const trees = Object.values(w.state().workspaces).filter(
      (ws: Record<string, unknown>) => ws.initial_command !== null && ws.initial_command !== undefined,
    ) as Array<Record<string, string>>;
    assert.equal(trees.length, 2);
    for (const ws of trees) {
      // The trailing exec keeps the terminal after the agent exits; cmux would otherwise
      // close the workspace the moment the command finishes.
      assert.match(
        ws.initial_command,
        /^grove agent run feat-checkout --tree feat-checkout@\w+ --agent claude; exec "\$\{SHELL:-\/bin\/zsh\}" -l$/,
      );
      // The command names the same Tree the workspace sits in.
      const tree = /--tree (\S+)/.exec(ws.initial_command)![1]!;
      assert.equal(ws.current_directory, w.treePaths[tree]);
    }

    // The command is part of workspace.create, so there is no separate injection call.
    const injections = w.state().calls.filter((c: { method: string }) =>
      /send|input|paste|keys/i.test(c.method),
    );
    assert.deepEqual(injections, []);
  } finally {
    w.cleanup();
  }
});

test('AC-12: the workspace outlives the agent — measured, not assumed', () => {
  const w = makeWorld();
  try {
    // The fake closes any workspace whose initial_command lacks a keepalive, because that is
    // what cmux does: three real workspaces vanished within two seconds of their agents
    // finishing. This case therefore fails if the wrapper stops appending the exec.
    const r = runJson(w, ['open', w.root, '--agent', 'claude']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.summary.present, 2, 'the workspaces died with their agents');

    // And a second look, after the agents would long since have exited.
    const again = runJson(w, ['status', w.root]);
    assert.equal(again.json.summary.present, 2);
    assert.equal(again.json.summary.missing, 0);
  } finally {
    w.cleanup();
  }
});

const FORBIDDEN = /sidebar|dock|settings|hooks|shortcuts|themes|feedback|browser/i;

test('AC-15: no normal command touches sidebar, Dock, settings, hook or shortcut surfaces', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    run(w, ['sync', w.root]);
    run(w, ['status', w.root]);
    run(w, ['sync', w.root, '--allow-destructive']);
    const calls = w.state().calls as Array<{ method: string }>;
    assert.ok(calls.length > 0, 'no calls were recorded, so this proves nothing');
    for (const c of calls) {
      assert.ok(!FORBIDDEN.test(c.method), `a normal command called ${c.method}`);
    }
  } finally {
    w.cleanup();
  }
});

test('AC-15: the source names no sidebar, Dock, settings, hook or shortcut surface', () => {
  const files = execFileSync('/bin/bash', ['-c', `ls ${JSON.stringify(join(REPO, 'src'))}/*.ts`], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      // Only calls matter; the word may legitimately appear in prose.
      const m = /rpc[<(]\s*['"]([\w.]+)['"]/.exec(line) ?? /execFileAsync\([^,]+,\s*\[['"]([\w-]+)['"]/.exec(line);
      if (m) assert.ok(!FORBIDDEN.test(m[1]!), `${f} calls ${m[1]}`);
    }
  }
});

test('AC-01, AC-17: the packed tarball installs into a clean prefix and runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grove-cmux-pack-'));
  try {
    const packed = execFileSync('npm', ['pack', '--pack-destination', dir], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, npm_config_loglevel: 'error' },
    })
      .trim()
      .split('\n')
      .pop()!;
    const prefix = join(dir, 'prefix');
    mkdirSync(prefix, { recursive: true });
    execFileSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', join(dir, packed)], {
      encoding: 'utf8',
      env: { ...process.env, npm_config_loglevel: 'error' },
    });
    const bin = join(prefix, 'node_modules', '.bin', 'grove-cmux');
    chmodSync(bin, 0o755);
    const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
    assert.equal(version, JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version);
    const help = execFileSync(bin, ['--help'], { encoding: 'utf8' });
    for (const cmd of ['open', 'sync', 'status', 'new']) assert.match(help, new RegExp(cmd));
    // engines says Node 24; nothing in the package may require a newer runtime feature.
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    assert.equal(pkg.engines.node, '>=24');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
