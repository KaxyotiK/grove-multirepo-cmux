/**
 * `run`: hand one task to one agent in one Tree.
 *
 * The case that matters is the second launch. `open --agent` rides on
 * `workspace.create`'s initial_command, which fires only when the workspace is created, so it
 * can start an agent exactly once per Tree and is a silent no-op every time after. A handoff
 * is a repeat operation against a Grove that is already open, which is why `run` goes through
 * `surface.create` into the workspace the ledger already names.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, run, runJson } from '../helpers/world.mjs';
import { agentCommand } from '../../src/engine.ts';

/** A fake grove that answers `agent ls` and nothing else. */
function fakeGroveAgents(world: ReturnType<typeof makeWorld>, agents: unknown[]) {
  const bin = join(world.base, 'fake-grove-agents');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('agent') && argv.includes('ls')) {
  // The real shape: a bare object with no schemaVersion, which is why it cannot go through
  // the envelope parser every other grove call uses.
  process.stdout.write(JSON.stringify({ agents: ${JSON.stringify(agents)}, default: null }));
  process.exit(0);
}
process.stderr.write('unexpected grove call: ' + argv.join(' ') + '\\n');
process.exit(1);
`,
    { mode: 0o755 },
  );
  return bin;
}

function surfaces(w: ReturnType<typeof makeWorld>) {
  return Object.values((w.state().surfaces ?? {}) as Record<string, Record<string, unknown>>);
}

test('run projects a Grove that was not open, then launches in the Tree it names', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['run', w.root, '--tree', 'api', '--agent', 'claude']);
    assert.equal(r.code, 0, r.stderr);

    const s = surfaces(w);
    assert.equal(s.length, 1, 'expected exactly one surface');
    const tree = `${w.grove}@api`;
    assert.equal(s[0]!.current_directory, w.treePaths[tree]);
    assert.match(String(s[0]!.initial_command), /grove agent run .* --tree .*@api --agent claude/);

    // The report names what was launched and where.
    assert.equal(r.json.launched.length, 1);
    assert.equal(r.json.launched[0].tree, tree);
    assert.equal(r.json.launched[0].surface_id, s[0]!.id);
  } finally {
    w.cleanup();
  }
});

test('AC-21: run launches into a Grove that is ALREADY open, creating no workspace', () => {
  const w = makeWorld();
  try {
    assert.equal(run(w, ['open', w.root]).code, 0);
    const before = Object.keys(w.state().workspaces).length;

    const r = runJson(w, ['run', w.root, '--tree', 'web', '--agent', 'claude']);
    assert.equal(r.code, 0, r.stderr);

    assert.equal(
      Object.keys(w.state().workspaces).length,
      before,
      'run created a workspace instead of reusing the projected one',
    );
    assert.equal(surfaces(w).length, 1);
    // This is the whole point: the second handoff works. `open --agent` here starts nothing.
    assert.equal(runJson(w, ['run', w.root, '--tree', 'web', '--agent', 'claude']).code, 0);
    assert.equal(surfaces(w).length, 2, 'the second handoff did not launch');
  } finally {
    w.cleanup();
  }
});

test('D3: the surface targets the workspace id the LEDGER holds, never a path match', () => {
  const w = makeWorld();
  try {
    assert.equal(run(w, ['open', w.root]).code, 0);
    const tree = `${w.grove}@api`;
    const ledgered = w.ledger()!.trees[tree];

    assert.equal(run(w, ['run', w.root, '--tree', 'api', '--agent', 'claude']).code, 0);

    const call = w.state().calls.filter((c: { method: string }) => c.method === 'surface.create');
    assert.equal(call.length, 1);
    assert.equal(call[0].params.workspace_id, ledgered);
    assert.equal(surfaces(w)[0]!.workspace_id, ledgered);
  } finally {
    w.cleanup();
  }
});

test('AC-21: everything after -- reaches the agent verbatim, a multi-word prompt included', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, [
      'run', w.root, '--tree', 'api', '--agent', 'claude',
      '--', '--model', 'opus', 'do the thing, carefully',
    ]);
    assert.equal(r.code, 0, r.stderr);
    const cmd = String(surfaces(w)[0]!.initial_command);
    // grove forwards everything after its own `--` to the agent, so the separator has to
    // survive, and the prompt has to stay ONE argument rather than three.
    assert.match(cmd, / -- --model opus 'do the thing, carefully'/);
  } finally {
    w.cleanup();
  }
});

test('run without --tree refuses E_USAGE rather than guessing a Tree', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['run', w.root, '--agent', 'claude']);
    assert.equal(r.code, 2);
    assert.equal(r.json.class, 'E_USAGE');
    assert.equal(Object.keys(w.state().workspaces).length, 0, 'it projected before refusing');
  } finally {
    w.cleanup();
  }
});

test('a Tree this Grove does not have refuses and lists the ones it does', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['run', w.root, '--tree', 'nope', '--agent', 'claude']);
    assert.equal(r.code, 2);
    assert.equal(r.json.class, 'E_USAGE');
    assert.deepEqual(r.json.evidence.trees.sort(), [`${w.grove}@api`, `${w.grove}@web`]);
    assert.match(r.json.remedy, /api/);
    assert.equal(surfaces(w).length, 0);
  } finally {
    w.cleanup();
  }
});

test('the full Tree directory name works as well as the short one', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['run', w.root, '--tree', `${w.grove}@web`, '--agent', 'claude']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.launched[0].tree, `${w.grove}@web`);
  } finally {
    w.cleanup();
  }
});

test('an agent grove does not define is refused BEFORE anything is created', () => {
  const w = makeWorld();
  try {
    const bin = fakeGroveAgents(w, [{ name: 'prover', command: '/bin/echo', available: true }]);
    const r = runJson(w, ['run', w.root, '--tree', 'api', '--agent', 'cluade'], { GROVE_BIN: bin });
    assert.equal(r.code, 12);
    assert.equal(r.json.class, 'E_PRECONDITION');
    assert.deepEqual(r.json.evidence.defined, ['prover']);
    assert.match(r.json.remedy, /prover/);
    // The refusal costs nothing: a mistyped agent name must not leave a projection behind.
    assert.equal(w.state().mutations, 0, 'it mutated cmux before refusing');
    assert.equal(w.ledger(), null);
  } finally {
    w.cleanup();
  }
});

test('a defined agent whose command is not executable is refused too', () => {
  const w = makeWorld();
  try {
    const bin = fakeGroveAgents(w, [{ name: 'gone', command: '/nope', available: false }]);
    const r = runJson(w, ['run', w.root, '--tree', 'api', '--agent', 'gone'], { GROVE_BIN: bin });
    assert.equal(r.code, 12);
    assert.match(r.json.message, /not executable/);
  } finally {
    w.cleanup();
  }
});

test('a grove that cannot answer "agent ls" does not block the launch', () => {
  const w = makeWorld();
  try {
    // A grove that EXISTS and fails the subcommand — an older build, say. Failing to check is
    // not evidence that the agent is missing. The fixture has to be a real binary: using a
    // nonexistent path here conflated this with the case below, where nothing can run.
    const bin = join(w.base, 'grove-that-cannot-answer');
    writeFileSync(bin, '#!/bin/sh\necho "unknown subcommand" >&2\nexit 2\n', { mode: 0o755 });
    const r = runJson(w, ['run', w.root, '--tree', 'api', '--agent', 'claude'], {
      GROVE_BIN: bin,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(surfaces(w).length, 1);
  } finally {
    w.cleanup();
  }
});

test('an absolute GROVE_BIN that does not exist refuses before cmux is touched', () => {
  const w = makeWorld();
  try {
    // agentCommand puts this same absolute string in the terminal, where it cannot resolve
    // any differently. Launching would report a handoff into a command that cannot run, so
    // this refuses — and refuses before the projection, or a typo would still cost N+1
    // workspaces on the way to saying no.
    const r = runJson(w, ['run', w.root, '--tree', 'api', '--agent', 'claude'], {
      GROVE_BIN: '/nonexistent/grove',
    });
    assert.equal(r.code, 8, r.stderr);
    assert.equal(surfaces(w).length, 0, 'a surface was created despite the refusal');
    assert.equal(
      Object.keys(w.state().workspaces).length,
      0,
      'the Grove was projected despite the refusal',
    );
  } finally {
    w.cleanup();
  }
});

test('the same refusal applies with no --agent, because run still launches grove', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['run', w.root, '--tree', 'api'], { GROVE_BIN: '/nonexistent/grove' });
    assert.equal(r.code, 8, r.stderr);
    assert.equal(Object.keys(w.state().workspaces).length, 0);
  } finally {
    w.cleanup();
  }
});

test('a bare grove missing from OUR PATH stays lenient: the terminal PATH is not ours', () => {
  const w = makeWorld();
  try {
    // GROVE_BIN unset and `grove` unresolvable here. The surface runs in a login shell that
    // may well have it, so refusing would break a working handoff on the evidence of a PATH
    // that does not govern the launch.
    //
    // The PATH still needs node, because the fake cmux is a `#!/usr/bin/env node` script —
    // hence a shim holding node and nothing else, rather than an empty PATH.
    const shim = join(w.base, 'shim');
    mkdirSync(shim, { recursive: true });
    symlinkSync(process.execPath, join(shim, 'node'));
    const r = runJson(w, ['run', w.root, '--tree', 'api', '--agent', 'claude'], {
      GROVE_BIN: '',
      PATH: shim,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(surfaces(w).length, 1);
  } finally {
    w.cleanup();
  }
});

test('with no --agent the Tree default runs, so the flag is omitted from the command', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['run', w.root, '--tree', 'api']);
    assert.equal(r.code, 0, r.stderr);
    const cmd = String(surfaces(w)[0]!.initial_command);
    assert.match(cmd, /grove agent run /);
    assert.ok(!cmd.includes('--agent'), `--agent was invented: ${cmd}`);
  } finally {
    w.cleanup();
  }
});

test('GROVE_BIN reaches the launched command, because PATH in the terminal is not ours', () => {
  const w = makeWorld();
  try {
    const bin = fakeGroveAgents(w, [{ name: 'claude', command: '/bin/echo', available: true }]);
    const r = runJson(w, ['run', w.root, '--tree', 'api', '--agent', 'claude'], { GROVE_BIN: bin });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      String(surfaces(w)[0]!.initial_command).startsWith(`${bin} agent run`),
      `the command did not use GROVE_BIN: ${surfaces(w)[0]!.initial_command}`,
    );
  } finally {
    w.cleanup();
  }
});

test('the launch command ends in a shell exec, whatever else it carries', () => {
  // The keepalive is what stops cmux closing the surface the moment the agent exits. The
  // property is that it is LAST: appending anything after it silently reintroduces the bug,
  // which a check for "contains ; exec" could never see.
  for (const argv of [[], ['--model', 'opus'], ['a; echo pwned'], ['--', '--weird']]) {
    const cmd = agentCommand('g', 'g@api', 'claude', argv);
    const last = cmd.split(/;|&&|\|\|/).pop()!.trim();
    assert.match(last, /^exec\s+"\$\{SHELL/, `keepalive is not last for ${JSON.stringify(argv)}`);
  }
});

test('the launch command STARTS with the grove binary, because cmux resolves that token', () => {
  // Measured against the live socket: cmux resolves the first whitespace-delimited token of
  // `initial_command` as an executable, and when it does not resolve, the command silently
  // does not run — no error, no output, a surface indistinguishable from a working one.
  // `export FOO=1; …`, `{ … }` and `true; …` all disappear that way. So the first token of
  // anything we hand cmux has to be a program, which forbids prefixing this command with an
  // assignment, a `cd`, or any other shell builtin.
  for (const bin of ['grove', '/opt/homebrew/bin/grove']) {
    const prev = process.env.GROVE_BIN;
    process.env.GROVE_BIN = bin;
    try {
      const first = agentCommand('g', 'g@api', 'claude', ['task']).split(/\s+/)[0]!;
      assert.equal(first, bin, 'the command no longer begins with an executable');
      assert.ok(!/^[{(]|[=;]/.test(first), `first token is not a program: ${first}`);
    } finally {
      if (prev === undefined) delete process.env.GROVE_BIN;
      else process.env.GROVE_BIN = prev;
    }
  }
});
