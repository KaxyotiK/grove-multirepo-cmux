/**
 * The two renderers.
 *
 * Both are pure functions of one Report. Neither computes a classification, an action, or a
 * count of its own. The human summary line is a fold over the same `actions` array the JSON
 * carries and `sync` executes, so the two renderings cannot express different decisions.
 */

import type { Action, Classification, GroupState, Item, Plan } from './classify.ts';
import type { CmuxVersion } from './cmux.ts';
import type { WindowSource } from './window.ts';

export const STATUS_SCHEMA = 'grove-cmux.status/1';

export interface Report {
  grove: { name: string; root: string };
  cmux: CmuxVersion & { minimum_build: string | null; below_minimum: boolean };
  window: { id: string; source: WindowSource };
  ledger: { present: boolean; path: string; schema: number | null; cmux_build: string | null };
  plan: Plan;
  warnings: string[];
  /** Set by sync; absent on status. */
  applied?: Action[];
  /** Set by run: what was actually launched, and where. */
  launched?: Launch[];
}

export interface Launch {
  surface_id: string;
  workspace_id: string;
  tree: string;
  command: string;
}

const ORDER: Classification[] = [
  'present',
  'detached',
  'missing',
  'stale',
  'foreign',
  'ignore',
];

export function renderJson(report: Report | Report[]): string {
  if (Array.isArray(report)) {
    return `${JSON.stringify(
      { schema: STATUS_SCHEMA, windows: report.map(reportBody) },
      null,
      2,
    )}\n`;
  }
  return `${JSON.stringify({ schema: STATUS_SCHEMA, ...reportBody(report) }, null, 2)}\n`;
}

function reportBody(r: Report) {
  return {
    grove: r.grove,
    cmux: {
      version: r.cmux.version,
      build: r.cmux.build,
      hash: r.cmux.hash,
      minimum_build: r.cmux.minimum_build,
      below_minimum: r.cmux.below_minimum,
    },
    window: r.window,
    ledger: r.ledger,
    group: r.plan.group,
    items: r.plan.items,
    summary: r.plan.summary,
    actions: r.plan.actions,
    warnings: r.warnings,
    ...(r.applied ? { applied: r.applied } : {}),
    ...(r.launched ? { launched: r.launched } : {}),
  };
}

export function renderHuman(report: Report | Report[], opts: { all?: boolean } = {}): string {
  if (Array.isArray(report)) {
    return report.map((r) => renderHuman(r, opts)).join('\n');
  }
  const r = report;
  const lines: string[] = [];
  lines.push(`grove ${r.grove.name}   ${r.grove.root}`);
  lines.push(
    `window ${r.window.id} (${r.window.source})   group ${describeGroup(r.plan.group)}   cmux ${r.cmux.raw}`,
  );
  lines.push(
    `ledger ${r.ledger.present ? r.ledger.path : 'absent'}${
      r.ledger.present ? ` schema ${r.ledger.schema}` : ''
    }`,
  );
  lines.push('');

  const shown = r.plan.items
    .filter((i) => opts.all || i.classification !== 'ignore')
    .sort((a, b) => ORDER.indexOf(a.classification) - ORDER.indexOf(b.classification));

  if (shown.length === 0) {
    lines.push('  (nothing to report)');
  } else {
    const w1 = Math.max(...shown.map((i) => i.classification.length));
    const w2 = Math.max(1, ...shown.map((i) => (i.tree ?? '—').length));
    for (const i of shown) {
      lines.push(
        `  ${i.classification.padEnd(w1)}  ${(i.tree ?? '—').padEnd(w2)}  ${evidenceFor(i)}`,
      );
    }
  }

  lines.push('');
  lines.push(summaryLine(r.plan.summary, Boolean(opts.all)));
  const preview = actionPreview(r.plan.actions, r.applied);
  if (preview) lines.push(preview);
  for (const l of r.launched ?? []) {
    lines.push(`launched ${l.tree} in surface ${l.surface_id.slice(0, 8)}: ${l.command}`);
  }
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return `${lines.join('\n')}\n`;
}

function describeGroup(g: GroupState): string {
  if (g.state === 'never_created') return '(none yet)';
  return `${g.id ?? '—'} [${g.state}]`;
}

function evidenceFor(i: Item): string {
  const id = i.workspace_id ? i.workspace_id.slice(0, 8) : '—';
  switch (i.classification) {
    case 'present':
      return `${id}  ${i.tree_path ?? ''}`;
    case 'detached':
      return `${id}  live, not in our group`;
    case 'missing':
      return i.reason === 'workspace_not_found'
        ? '—         workspace in ledger no longer exists'
        : '—         never projected';
    case 'stale':
      return `${id}  tree no longer on disk`;
    case 'foreign':
      return `${id}  ${i.in_group ? `group ${i.in_group.slice(0, 8)}` : 'ungrouped'}, not in ledger`;
    default:
      return `${id}  ${i.current_directory ?? ''}`;
  }
}

function summaryLine(summary: Record<Classification, number>, all: boolean): string {
  const parts: string[] = [];
  for (const c of ORDER) {
    if (c === 'ignore' && !all) continue;
    if (summary[c] > 0) parts.push(`${summary[c]} ${c}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'nothing classified';
}

/** The action preview is a fold over the same array sync executes. */
export function actionPreview(actions: Action[], applied?: Action[]): string | null {
  const closingProjection = actions.some((a) => a.reason === 'projection_closed');
  if (applied) {
    const creates = applied.filter((a) => a.op === 'workspace.create').length;
    const attaches = applied.filter((a) => a.op === 'group.attach').length;
    const groups = applied.filter((a) => a.op === 'group.create').length;
    const closes = applied.filter((a) => a.op === 'workspace.close').length;
    const ungroups = applied.filter((a) => a.op === 'group.ungroup').length;
    const bits: string[] = [];
    if (groups) bits.push(`created ${groups} group`);
    if (creates) bits.push(`created ${creates} workspace${creates === 1 ? '' : 's'}`);
    if (attaches) bits.push(`re-attached ${attaches}`);
    if (closes) bits.push(`closed ${closes}`);
    if (ungroups) bits.push(`ungrouped ${ungroups}`);
    return bits.length > 0 ? bits.join('; ') : 'nothing to do';
  }
  const creates = actions.filter((a) => a.op === 'workspace.create').length;
  const attaches = actions.filter((a) => a.op === 'group.attach').length;
  const closes = actions.filter((a) => a.destructive).length;
  const ungroups = actions.filter((a) => a.op === 'group.ungroup').length;
  const bits: string[] = [];
  if (closingProjection) {
    const workspaceCloses = actions.filter((a) => a.op === 'workspace.close').length;
    if (workspaceCloses) {
      bits.push(`close would close ${workspaceCloses} workspace${workspaceCloses === 1 ? '' : 's'}`);
    }
    if (ungroups) bits.push(`close would ungroup ${ungroups} group${ungroups === 1 ? '' : 's'}`);
    return bits.length > 0 ? bits.join('; ') : 'close would change nothing';
  }
  if (creates || attaches) {
    const sub: string[] = [];
    if (creates) sub.push(`create ${creates}`);
    if (attaches) sub.push(`re-attach ${attaches}`);
    bits.push(`sync would ${sub.join(', ')}`);
  }
  if (closes) bits.push(`--allow-destructive would close ${closes}`);
  return bits.length > 0 ? bits.join('; ') : null;
}
