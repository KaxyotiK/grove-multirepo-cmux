/**
 * Branding, end to end through the built binary.
 *
 * The two options under test: O1 is the group header
 * icon and colour; O2 is the per-Tree sidebar status pill. Everything here is about the two
 * properties that could go wrong in a way nobody would notice: branding must reach only what
 * the ledger says is ours, and a cmux that cannot brand must still project.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, run, runJson } from '../helpers/world.mjs';
import { REQUIRED_METHODS } from '../../src/cmux.ts';

const ICON = 'leaf.fill';
const COLOR = '#2F9E44';
const KEY = 'grove';

interface Call {
  method: string;
  params: Record<string, string>;
}

const brandingCalls = (w: ReturnType<typeof makeWorld>): Call[] =>
  (w.state().calls as Call[]).filter((c) =>
    ['workspace.group.set_icon', 'workspace.group.set_color', 'set-status'].includes(c.method),
  );

test('O1: open gives the group it created the Grove icon and the Grove colour', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['open', w.root]);
    assert.equal(r.code, 0, r.stderr);
    const group = (Object.values(w.state().groups) as Array<Record<string, string>>)[0]!;
    assert.equal(group.icon_symbol, ICON);
    assert.equal(group.custom_color, COLOR);

    // Both are separate calls: workspace.group.create takes neither an icon nor a colour.
    const calls = brandingCalls(w);
    const icon = calls.find((c) => c.method === 'workspace.group.set_icon')!;
    const color = calls.find((c) => c.method === 'workspace.group.set_color')!;
    assert.equal(icon.params.group_id, group.id);
    assert.equal(color.params.group_id, group.id);
    assert.equal(icon.params.symbol, ICON);
    assert.equal(color.params.hex, COLOR);
    const create = (w.state().calls as Call[]).find((c) => c.method === 'workspace.group.create')!;
    assert.ok(!('icon' in create.params), 'group.create does not take an icon');
    assert.ok(!('color' in create.params), 'group.create does not take a colour');
  } finally {
    w.cleanup();
  }
});

test('O1: every branding RPC carries an explicit window_id, like every other mutation', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const rpcs = brandingCalls(w).filter((c) => c.method !== 'set-status');
    assert.ok(rpcs.length >= 2);
    for (const c of rpcs) assert.equal(c.params.window_id, 'W1', `${c.method} carried no window_id`);
  } finally {
    w.cleanup();
  }
});

test('O1: a second reconcile re-brands nothing, because the header already carries it', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const before = brandingCalls(w).filter((c) => c.method !== 'set-status').length;
    run(w, ['sync', w.root]);
    const after = brandingCalls(w).filter((c) => c.method !== 'set-status').length;
    assert.equal(after, before, 'the group was re-branded on a run that had nothing to change');
  } finally {
    w.cleanup();
  }
});

test('O1: a colour a person chose for our group is left alone, the way a title is', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    w.setState((s) => {
      for (const g of Object.values(s.groups) as Array<Record<string, string>>) {
        g.custom_color = '#ff0000';
        g.icon_symbol = 'hammer';
      }
    });
    const r = runJson(w, ['sync', w.root]);
    assert.equal(r.code, 0, r.stderr);
    const g = (Object.values(w.state().groups) as Array<Record<string, string>>)[0]!;
    assert.equal(g.custom_color, '#ff0000', "the wrapper overwrote a person's colour");
    assert.equal(g.icon_symbol, 'hammer', "the wrapper overwrote a person's icon");
  } finally {
    w.cleanup();
  }
});

test('O1: a foreign group is never restyled, even while it holds our workspaces', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    const ours = Object.values(w.ledger()!.trees) as string[];

    // The state D5 settled: a person dissolves our group and drags our workspaces into one of
    // their own. Sync reclaims the workspaces into a new group of ours and must not touch
    // theirs — including not branding it, which would be the same position inference in paint.
    w.setState((s) => {
      s.groups = {};
      s.workspaces.theirAnchor = {
        id: 'theirAnchor', window_id: 'W1', title: 'theirs', current_directory: '/elsewhere',
      };
      s.groups.GTHEIRS = {
        id: 'GTHEIRS', window_id: 'W1', name: 'theirs',
        anchor_workspace_id: 'theirAnchor',
        member_workspace_ids: ['theirAnchor', ...ours],
        icon_symbol: null,
        custom_color: null,
      };
    });
    const r = runJson(w, ['sync', w.root]);
    assert.equal(r.code, 0, r.stderr);

    const theirs = w.state().groups.GTHEIRS;
    assert.equal(theirs.icon_symbol, null, 'a stranger group was given the Grove icon');
    assert.equal(theirs.custom_color, null, 'a stranger group was given the Grove colour');
    for (const c of brandingCalls(w)) {
      assert.notEqual(c.params.group_id, 'GTHEIRS', 'a branding call named a stranger group');
      assert.notEqual(c.params.workspace_id, 'theirAnchor', "a pill was set on a stranger's workspace");
    }
    // And the group it did make is branded, so the reclaim is still visibly a Grove.
    const gid = w.ledger()!.group_id as string;
    assert.equal(w.state().groups[gid].icon_symbol, ICON);
  } finally {
    w.cleanup();
  }
});

test('O2: one pill per owned Tree, on a stable key, overwritten rather than accumulated', () => {
  const w = makeWorld({ trees: ['api', 'web', 'docs'] });
  try {
    run(w, ['open', w.root]);
    const ledger = w.ledger()!;
    const owned = Object.values(ledger.trees) as string[];
    assert.equal(owned.length, 3);

    const first = brandingCalls(w).filter((c) => c.method === 'set-status');
    assert.equal(first.length, 3, 'one pill per Tree, no more and no less');
    assert.deepEqual(first.map((c) => c.params.workspace_id).sort(), [...owned].sort());
    for (const c of first) {
      assert.equal(c.params.key, KEY);
      assert.equal(c.params.value, w.grove, 'the pill carries the Grove name');
      assert.equal(c.params.icon, ICON);
      assert.equal(c.params.color, COLOR);
    }

    // The anchor is not a Tree: the header already carries the Grove there.
    assert.ok(
      !first.some((c) => c.params.workspace_id === ledger.anchor_workspace_id),
      'the anchor was given a pill it does not need',
    );

    run(w, ['sync', w.root]);
    const status = w.state().status as Record<string, Record<string, unknown>>;
    for (const id of owned) {
      assert.deepEqual(Object.keys(status[id]!), [KEY], 'repeated reconciles accumulated rows');
    }
  } finally {
    w.cleanup();
  }
});

test('O2: a workspace the ledger does not name never gets a pill', () => {
  const w = makeWorld();
  try {
    // A person's own workspace, sitting exactly on a Tree path. D4: never adopted, and now
    // never painted either.
    w.setState((s) => {
      s.workspaces.squatter = {
        id: 'squatter', window_id: 'W1', title: 'theirs',
        current_directory: w.treePaths[`${w.grove}@api`],
      };
    });
    const r = runJson(w, ['open', w.root]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      !((w.state().status as Record<string, unknown>).squatter),
      'a foreign workspace was given a Grove pill',
    );
    for (const c of brandingCalls(w)) {
      assert.notEqual(c.params.workspace_id, 'squatter');
    }
  } finally {
    w.cleanup();
  }
});

test('O1, O2: --dry-run issues no branding mutation, the same as it issues no other one', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['sync', w.root, '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(brandingCalls(w), []);
    assert.deepEqual(w.state().status, {});
  } finally {
    w.cleanup();
  }
});

test('O1, O2: status issues no branding call either, so the read-only guard still holds', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    w.setState((s) => { s.calls = []; });
    const r = runJson(w, ['status', w.root]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(brandingCalls(w), []);
  } finally {
    w.cleanup();
  }
});

test('O1, O2: GROVE_CMUX_BRAND=off projects the Grove and paints nothing', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['open', w.root], { GROVE_CMUX_BRAND: 'off' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.summary.present, 2);
    assert.deepEqual(brandingCalls(w), []);
    const g = (Object.values(w.state().groups) as Array<Record<string, string>>)[0]!;
    assert.equal(g.icon_symbol, null);
    assert.equal(g.custom_color, null);
  } finally {
    w.cleanup();
  }
});

test('O1: an override reaches both surfaces, so one edit changes what a Grove looks like', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['open', w.root], {
      GROVE_CMUX_BRAND_ICON: 'sparkle',
      GROVE_CMUX_BRAND_COLOR: '#7A4FD8',
    });
    assert.equal(r.code, 0, r.stderr);
    const g = (Object.values(w.state().groups) as Array<Record<string, string>>)[0]!;
    assert.equal(g.icon_symbol, 'sparkle');
    assert.equal(g.custom_color, '#7A4FD8');
    for (const c of brandingCalls(w).filter((x) => x.method === 'set-status')) {
      assert.equal(c.params.icon, 'sparkle');
      assert.equal(c.params.color, '#7A4FD8');
    }
  } finally {
    w.cleanup();
  }
});

test('O1: a malformed override warns and paints the default rather than refusing the run', () => {
  const w = makeWorld();
  try {
    const r = runJson(w, ['open', w.root], { GROVE_CMUX_BRAND_COLOR: 'green' });
    assert.equal(r.code, 0, r.stderr);
    const g = (Object.values(w.state().groups) as Array<Record<string, string>>)[0]!;
    assert.equal(g.custom_color, COLOR);
    assert.ok(
      r.json.warnings.some((x: string) => /GROVE_CMUX_BRAND_COLOR/.test(x)),
      'the fallback was silent',
    );
  } finally {
    w.cleanup();
  }
});

test('a cmux that rejects every branding call still completes the projection', () => {
  const w = makeWorld({ trees: ['api', 'web', 'docs'] });
  try {
    const r = runJson(w, ['open', w.root], { FAKE_CMUX_REJECT_BRANDING: '1' });
    // The projection is the product; the paint is not. Exit 0, everything projected.
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.summary.present, 3);
    const ledger = w.ledger()!;
    assert.equal(Object.keys(ledger.trees).length, 3);
    assert.ok(w.state().groups[ledger.group_id as string], 'the group was not created');

    const g = (Object.values(w.state().groups) as Array<Record<string, string>>)[0]!;
    assert.equal(g.icon_symbol, null);
    assert.equal(g.custom_color, null);
    assert.deepEqual(w.state().status, {});

    // Silent best-effort would be worse than none: every failure is on the report.
    const warned = r.json.warnings.filter((x: string) => /could not set/.test(x));
    assert.equal(warned.length, 5, `expected one warning per failed call, got ${warned.join(' | ')}`);
  } finally {
    w.cleanup();
  }
});

test('a build whose capabilities lack the branding methods warns and still projects', () => {
  const w = makeWorld();
  try {
    w.setState((s) => {
      // Every required method and nothing else, so only the branding methods are absent.
      s.capabilities = [...REQUIRED_METHODS];
    });
    const r = runJson(w, ['open', w.root], { FAKE_CMUX_REJECT_BRANDING: '1' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.summary.present, 2);
    assert.ok(
      r.json.warnings.some((x: string) => /workspace\.group\.set_icon/.test(x)),
      'the missing optional methods were not named',
    );
  } finally {
    w.cleanup();
  }
});

test('an icon cmux cannot render is a silent no-op there, so the run still succeeds', () => {
  const w = makeWorld();
  try {
    // grove.logo is not an SF Symbol. cmux stores null and the header keeps folder.fill; it
    // does not report an error, which is exactly why an invented name is not an option.
    const r = runJson(w, ['open', w.root], { GROVE_CMUX_BRAND_ICON: 'grove.logo' });
    assert.equal(r.code, 0, r.stderr);
    const g = (Object.values(w.state().groups) as Array<Record<string, string>>)[0]!;
    assert.equal(g.icon_symbol, null);
    assert.equal(g.custom_color, COLOR, 'the colour is independent of the icon');
  } finally {
    w.cleanup();
  }
});

/**
 * The boundary O2 sits on.
 *
 * The plan's AC-15 forbids touching "sidebar, Dock, settings, hook or shortcut surfaces", and
 * the pill is drawn in the sidebar. What that criterion is protecting is ownership: the
 * wrapper must not acquire a config file, a hook or a view of its own. `set-status` acquires
 * none — it is a per-workspace metadata write addressed by a UUID the ledger already holds.
 * This case pins the narrowed boundary so a future edit cannot widen it quietly.
 */
test('O2: the only surface command the wrapper issues is set-status, on ids it owns', () => {
  const w = makeWorld();
  try {
    run(w, ['open', w.root]);
    run(w, ['sync', w.root]);
    run(w, ['status', w.root]);
    const owned = new Set<string>([
      ...(Object.values(w.ledger()!.trees) as string[]),
      w.ledger()!.anchor_workspace_id as string,
      w.ledger()!.group_id as string,
      'W1',
    ]);
    for (const c of w.state().calls as Call[]) {
      if (c.method.startsWith('workspace.') || ['version', 'capabilities', 'list-windows', 'identify'].includes(c.method)) {
        continue;
      }
      assert.equal(c.method, 'set-status', `the wrapper reached a new surface: ${c.method}`);
      assert.ok(owned.has(c.params.workspace_id!), 'set-status named an id the ledger does not hold');
    }
  } finally {
    w.cleanup();
  }
});

test('close neither requires nor warns about the branding methods, and never brands', () => {
  const w = makeWorld();
  try {
    const opened = run(w, ['open', w.root]);
    assert.equal(opened.code, 0, opened.stderr);
    w.setState((s) => {
      // Only what close calls: no branding method is advertised.
      s.capabilities = ['workspace.list', 'workspace.group.list', 'workspace.close'];
      s.calls = [];
    });
    const r = runJson(w, ['close', w.root]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      !r.json.warnings.some((x: string) => /set_icon|set_color|icon or colour/.test(x)),
      `close warned about branding: ${r.json.warnings.join(' | ')}`,
    );
    assert.ok(!w.state().calls.some((c: { method: string }) =>
      ['workspace.group.set_icon', 'workspace.group.set_color', 'set-status'].includes(c.method),
    ), 'close issued a branding call');
  } finally {
    w.cleanup();
  }
});
