/**
 * AC-14. Both renderers are pure functions of one Report, so the property under test is not
 * "the strings look right" but "neither rendering can express a decision the other does not".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../src/classify.ts';
import { __clearWorktreeCache, __setWorktreeForTest } from '../../src/git.ts';
import { emptyLedger } from '../../src/ledger.ts';
import { renderHuman, renderJson, STATUS_SCHEMA, type Report } from '../../src/render.ts';

const ROOT = '/g/acme';

function report(): Report {
  __clearWorktreeCache();
  const plan = classify({
    grove: {
      name: 'acme',
      root: ROOT,
      skipped: [],
      trees: ['acme@api', 'acme@web', 'acme@docs'].map((name) => ({
        name,
        shortName: name.split('@')[1]!,
        path: `${ROOT}/trees/${name}`,
        existsOnDisk: true,
      })),
    },
    ledger: {
      ...emptyLedger('acme'),
      group_id: 'G1',
      anchor_workspace_id: 'anchor',
      trees: { 'acme@api': 'wsA', 'acme@docs': 'wsD', 'acme@old': 'wsOld' },
    },
    workspaces: [
      { id: 'anchor', current_directory: ROOT },
      { id: 'wsA', current_directory: `${ROOT}/trees/acme@api` },
      { id: 'wsD', current_directory: `${ROOT}/trees/acme@docs` },
      { id: 'wsOld', current_directory: `${ROOT}/trees/acme@old` },
      { id: 'stranger', current_directory: '/elsewhere' },
    ],
    groups: [{ id: 'G1', name: 'acme', anchor_workspace_id: 'anchor', member_workspace_ids: ['wsA'] }],
  });
  return {
    grove: { name: 'acme', root: ROOT },
    cmux: {
      version: '0.64.22',
      build: '102',
      hash: 'ddd4a01bc',
      raw: '0.64.22 (102) [ddd4a01bc]',
      minimum_build: '102',
      below_minimum: false,
    },
    window: { id: 'W1', source: 'sole-window' },
    ledger: { present: true, path: `${ROOT}/.grove-cmux/projection.json`, schema: 1, cmux_build: '102' },
    plan,
    warnings: [],
  };
}

test('the fixture exercises present, detached, missing, stale and ignore at once', () => {
  const s = report().plan.summary;
  assert.equal(s.present, 1);
  assert.equal(s.detached, 1);
  assert.equal(s.missing, 1);
  assert.equal(s.stale, 1);
  assert.equal(s.ignore, 1);
});

test('the JSON carries the schema, the items, the summary and the actions', () => {
  const j = JSON.parse(renderJson(report()));
  assert.equal(j.schema, STATUS_SCHEMA);
  assert.equal(j.items.length, 5);
  assert.ok(Array.isArray(j.actions));
  assert.deepEqual(Object.keys(j.summary).sort(), [
    'detached',
    'foreign',
    'ignore',
    'missing',
    'present',
    'stale',
  ]);
});

test('every classification in the JSON appears in the human text, and none is invented', () => {
  const r = report();
  const j = JSON.parse(renderJson(r));
  const human = renderHuman(r, { all: true });
  const fromJson = new Set<string>(j.items.map((i: { classification: string }) => i.classification));
  const bodyLines = human
    .split('\n')
    .filter((l) => l.startsWith('  ') && l.trim().length > 0)
    .map((l) => l.trim().split(/\s+/)[0]!);
  assert.deepEqual(new Set(bodyLines), fromJson);
});

test('the human counts equal the JSON summary, class by class', () => {
  const r = report();
  const j = JSON.parse(renderJson(r));
  const human = renderHuman(r, { all: true });
  for (const [cls, n] of Object.entries(j.summary) as Array<[string, number]>) {
    if (n === 0) continue;
    assert.match(human, new RegExp(`${n} ${cls}\\b`), `human summary is missing "${n} ${cls}"`);
  }
});

test('the human action preview is a fold over the same actions array', () => {
  const r = report();
  const j = JSON.parse(renderJson(r));
  const human = renderHuman(r);
  const creates = j.actions.filter((a: { op: string }) => a.op === 'workspace.create').length;
  const attaches = j.actions.filter((a: { op: string }) => a.op === 'group.attach').length;
  const closes = j.actions.filter((a: { destructive: boolean }) => a.destructive).length;
  if (creates) assert.match(human, new RegExp(`create ${creates}`));
  if (attaches) assert.match(human, new RegExp(`re-attach ${attaches}`));
  if (closes) assert.match(human, new RegExp(`--allow-destructive would close ${closes}`));
});

test('AC-29: the close preview describes close and ungroup actions without sync wording', () => {
  const r = report();
  r.plan.actions = [
    {
      op: 'workspace.close', tree: 'acme@api', workspace_id: 'wsA', destructive: true,
      reason: 'projection_closed',
    },
    {
      op: 'group.ungroup', tree: null, workspace_id: 'G1', destructive: false,
      reason: 'projection_closed',
    },
  ];
  const human = renderHuman(r);
  assert.match(human, /close would close 1 workspace/);
  assert.match(human, /close would ungroup 1 group/);
  assert.doesNotMatch(human, /allow-destructive|sync would/);
});

test('ignore rows are suppressed by default and shown with --all', () => {
  const r = report();
  assert.equal(renderHuman(r).includes('ignore'), false);
  assert.equal(renderHuman(r, { all: true }).includes('ignore'), true);
  // The JSON always carries them, because a machine reader does not need the courtesy.
  assert.equal(
    JSON.parse(renderJson(r)).items.some((i: { classification: string }) => i.classification === 'ignore'),
    true,
  );
});

test('with no window the JSON becomes a windows array under one schema key', () => {
  const j = JSON.parse(renderJson([report(), report()]));
  assert.equal(j.schema, STATUS_SCHEMA);
  assert.equal(j.windows.length, 2);
  assert.equal(j.windows[0].schema, undefined);
});

/**
 * The original fixture had `foreign: 0` and `ambiguous: 0`, so `evidenceFor`'s two most
 * consequential branches were rendered by no test at all. A wrong human line for a foreign
 * row was invisible for exactly that reason.
 */
function reportWithUnowned(): Report {
  __clearWorktreeCache();
  __setWorktreeForTest(`${ROOT}/trees/acme@api`, `${ROOT}/trees/acme@api`);
  const plan = classify({
    grove: {
      name: 'acme',
      root: ROOT,
      skipped: [],
      trees: ['acme@api', 'acme@web'].map((name) => ({
        name,
        shortName: name.split('@')[1]!,
        path: `${ROOT}/trees/${name}`,
        existsOnDisk: true,
      })),
    },
    ledger: {
      ...emptyLedger('acme'),
      trees: { 'acme@api': 'wsA', 'acme@web': 'wsB' },
    },
    workspaces: [
      { id: 'wsA', current_directory: `${ROOT}/trees/acme@api` },
      { id: 'wsB', current_directory: `${ROOT}/trees/acme@web` },
      { id: 'squatter', current_directory: `${ROOT}/trees/acme@api` },
    ],
    // Our two are split across two groups, which is the only thing that blocks.
    groups: [
      { id: 'GA', anchor_workspace_id: 'a1', member_workspace_ids: ['wsA'] },
      { id: 'GB', name: 'scratch', anchor_workspace_id: 'a2', member_workspace_ids: ['wsB', 'squatter'] },
    ],
  });
  const base = report();
  return { ...base, plan };
}

test('a foreign row renders its group and says it is not in the ledger', () => {
  const r = reportWithUnowned();
  assert.ok(r.plan.summary.foreign > 0, 'the fixture no longer produces a foreign row');
  const human = renderHuman(r, { all: true });
  const line = human.split('\n').find((l) => l.trim().startsWith('foreign'))!;
  assert.ok(line, 'no foreign row was rendered');
  assert.match(line, /squatter|not in ledger/);
  assert.match(line, /group [0-9a-zA-Z]+|ungrouped/);
});

test('every classification has a distinct human evidence line', () => {
  const seen = new Set<string>();
  for (const r of [report(), reportWithUnowned()]) {
    for (const line of renderHuman(r, { all: true }).split('\n')) {
      if (!line.startsWith('  ') || line.trim().length === 0) continue;
      seen.add(line.trim().split(/\s+/)[0]!);
    }
  }
  for (const cls of ['present', 'detached', 'missing', 'stale', 'foreign', 'ignore']) {
    assert.ok(seen.has(cls), `no test renders a ${cls} row`);
  }
});
