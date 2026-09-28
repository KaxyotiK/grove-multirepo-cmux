/**
 * Builds a disposable world for a CLI case: a real Grove directory tree with real git
 * worktrees, a fake cmux state file, and the environment that points grove-cmux at both.
 *
 * The Trees are real repositories because worktree resolution is a real `git rev-parse`.
 * A test that faked that would prove nothing about the classifier's evidence.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_CMUX = join(HERE, 'fake-cmux.mjs');
export const CLI = join(HERE, '..', '..', 'dist', 'cli.js');

export function makeWorld({ grove = 'feat-checkout', trees = ['api', 'web'] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'grove-cmux-test-'));
  const root = join(base, 'groves', grove);
  mkdirSync(join(root, 'trees'), { recursive: true });

  const treePaths = {};
  for (const t of trees) {
    const name = `${grove}@${t}`;
    const p = join(root, 'trees', name);
    mkdirSync(p, { recursive: true });
    git(p, ['init', '-q', '-b', 'main']);
    writeFileSync(join(p, 'README.md'), `# ${t}\n`);
    git(p, ['add', '.']);
    git(p, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    mkdirSync(join(p, 'src'), { recursive: true });
    treePaths[name] = p;
  }

  const statePath = join(base, 'cmux-state.json');
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        version: '0.64.22 (102) [ddd4a01bc]',
        windows: [{ id: 'W1', title: 'window one' }],
        workspaces: {},
        groups: {},
        status: {},
        mutations: 0,
        calls: [],
        password: null,
        running: true,
        caller: null,
        focused: 'W1',
      },
      null,
      2,
    ),
  );

  return {
    base,
    root,
    grove,
    treeNames: Object.keys(treePaths),
    treePaths,
    statePath,
    env: {
      ...process.env,
      FAKE_CMUX_STATE: statePath,
      GROVE_CMUX_CMUX_BIN: FAKE_CMUX,
      GROVE_CMUX_WINDOW: '',
    },
    state() {
      return JSON.parse(readFileSync(statePath, 'utf8'));
    },
    setState(mut) {
      const s = JSON.parse(readFileSync(statePath, 'utf8'));
      mut(s);
      writeFileSync(statePath, JSON.stringify(s, null, 2));
    },
    ledger() {
      const p = join(root, '.grove-cmux', 'projection.json');
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    },
    removeTree(name) {
      rmSync(join(root, 'trees', name), { recursive: true, force: true });
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** Run the built CLI. Returns { code, stdout, stderr }. */
export function run(world, args, extraEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...world.env, ...extraEnv },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
    };
  }
}

export function runJson(world, args, extraEnv = {}) {
  const r = run(world, [...args, '--json'], extraEnv);
  const text = r.code === 0 ? r.stdout : r.stderr;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave null so the assertion names the raw output */
  }
  return { ...r, json: parsed };
}
