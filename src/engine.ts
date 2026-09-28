/**
 * The engine: one observe pass shared by every command, and one executor for the actions
 * the classifier produced.
 *
 * `status` observes and renders. `sync --dry-run` observes and renders. `sync` observes,
 * renders and executes. All three consume the identical action array, so they cannot drift.
 */

import {
  CLOSE_METHODS,
  CmuxClient,
  OPTIONAL_METHODS,
  REQUIRED_METHODS,
  UNGROUP_METHOD,
  type CmuxGroup,
  type CmuxVersion,
  type CmuxWindow,
  type CmuxWorkspace,
} from './cmux.ts';
import { applyBranding, resolveBranding, type Branding } from './branding.ts';
import { classify, type Action, type Plan } from './classify.ts';
import { GroveCmuxError } from './errors.ts';
import { readGroveFromDisk, shortTreeName, type Grove, type Tree } from './grove.ts';
import {
  emptyLedger,
  forgetProjection,
  LedgerWriter,
  ledgerPath,
  readLedger,
  type Ledger,
} from './ledger.ts';
import type { Report } from './render.ts';
import { EnumerateAllWindows, findLedgerWindow, resolveWindow, type ResolvedWindow } from './window.ts';

/**
 * The minimum build grove-cmux requires. A build that merely differs from the build the
 * fixtures were captured against is not unusable, so it warns. Refusal is for a missing
 * capability or a build below this number: a flag everyone always passes is not a gate, it
 * is muscle memory, and it gets typed straight past on the day the drift is real.
 */
export const MINIMUM_CMUX_BUILD = 102;
export const FIXTURE_CMUX_BUILD = '102';
export const FIXTURE_CMUX_HASH = 'ddd4a01bc';

export interface ObserveOptions {
  groveRoot: string;
  client: CmuxClient;
  window?: string | null;
  mutating: boolean;
  /** --relocate: accept that the recorded window is gone and project here instead. */
  relocate?: boolean;
}

export interface Observation {
  grove: Grove;
  ledger: Ledger | null;
  window: ResolvedWindow;
  plan: Plan;
  report: Report;
  /**
   * The groups exactly as cmux reported them. Branding reads `icon_symbol` and `custom_color`
   * off our own group from here rather than issuing another list call, and the classifier's
   * `GroupState` deliberately does not carry them: they are not a classification.
   */
  groups: CmuxGroup[];
}

/**
 * `required` is the set the calling path actually uses, never a union across commands: a
 * method one command needs must not refuse another command that never calls it. `optional`
 * is scoped the same way, so a path that never brands is not warned about branding. `methods`
 * is returned so a path can demand positive evidence for a method it cannot afford to discover
 * missing by calling it; empty means the build's method list is unavailable.
 */
export async function checkCapability(
  client: CmuxClient,
  required: readonly string[] = REQUIRED_METHODS,
  optional: readonly string[] = OPTIONAL_METHODS,
): Promise<{ version: CmuxVersion; warnings: string[]; belowMinimum: boolean; methods: string[] }> {
  const version = await client.version();
  const warnings: string[] = [];
  const buildNum = version.build ? Number(version.build) : NaN;
  const belowMinimum = Number.isFinite(buildNum) && buildNum < MINIMUM_CMUX_BUILD;

  if (belowMinimum) {
    throw new GroveCmuxError(
      'E_CMUX_INCOMPATIBLE',
      `cmux build ${version.build} is below the minimum build ${MINIMUM_CMUX_BUILD}`,
      { observed: version.raw, minimum_build: MINIMUM_CMUX_BUILD },
    );
  }

  const methods = await client.capabilities();
  if (methods.length > 0) {
    const missing = required.filter((m) => !methods.includes(m));
    if (missing.length > 0) {
      throw new GroveCmuxError(
        'E_CMUX_INCOMPATIBLE',
        `this cmux build does not offer ${missing.join(', ')}`,
        { observed: version.raw, missing },
      );
    }
    // Branding is decoration, so its absence is said out loud and then ignored. Putting these
    // in REQUIRED_METHODS would refuse the projection over a header colour.
    const missingOptional = optional.filter((m) => !methods.includes(m));
    if (missingOptional.length > 0) {
      warnings.push(
        `this cmux build does not offer ${missingOptional.join(', ')}, so Grove groups will not carry the Grove icon or colour; the projection is unaffected`,
      );
    }
  }

  // Three materially different builds call themselves 0.64.22, so a bare difference is
  // recorded rather than enforced. Workspace UUIDs survive upgrades.
  if (version.build !== FIXTURE_CMUX_BUILD || version.hash !== FIXTURE_CMUX_HASH) {
    warnings.push(
      `cmux build ${version.raw} differs from the verified build ${FIXTURE_CMUX_BUILD} [${FIXTURE_CMUX_HASH}]; all required methods answered`,
    );
  }
  if (!Number.isFinite(buildNum)) {
    warnings.push(
      `cmux reported "${version.raw}", which carries no build number, so the minimum-build check could not run`,
    );
  }
  return { version, warnings, belowMinimum, methods };
}

export async function observe(opts: ObserveOptions): Promise<Observation | Observation[]> {
  const grove = readGroveFromDisk(opts.groveRoot);
  const ledger = readLedger(grove.root);
  const { version, warnings } = await checkCapability(opts.client);

  let window: ResolvedWindow;
  try {
    window = await resolveWindow({
      client: opts.client,
      flag: opts.window ?? null,
      ledger,
      mutating: opts.mutating,
      relocate: opts.relocate ?? false,
    });
  } catch (e) {
    if (e instanceof EnumerateAllWindows) {
      const out: Observation[] = [];
      for (const w of e.windows) {
        out.push(
          await observeWindow(grove, ledger, { id: w.id, source: 'flag' }, opts, version, warnings),
        );
      }
      return out;
    }
    throw e;
  }

  // D2: the ledger names a projection somewhere. If the resolved window is not where it
  // lives, this is a projection conflict, not a bad target the person named.
  //
  // The guard keys on any recorded object, not only on a recorded group. A ledger holding
  // Tree UUIDs and no group is exactly what a mid-run failure leaves behind, and keying on
  // group_id alone let that state be re-projected into a second window — the duplication the
  // ledger exists to prevent, reached through the one path that had no test.
  const hasProjection =
    ledger !== null && (ledger.group_id !== null || Object.keys(ledger.trees).length > 0);
  if (hasProjection && opts.mutating && !opts.relocate) {
    const found = await findLedgerWindow(opts.client, ledger!);
    if (found && found.windowId !== window.id) {
      throw new GroveCmuxError(
        'E_PROJECTION_CONFLICT',
        `grove ${grove.name} is already projected in window ${found.windowId}`,
        {
          recorded_window: ledger!.window_id,
          found_window: found.windowId,
          requested_window: window.id,
          workspaces_found: found.found,
          group_id: ledger!.group_id,
        },
        `run against window ${found.windowId}, or pass --relocate to re-project here and leave that window alone`,
      );
    }
    if (!found && ledger!.window_id && ledger!.window_id !== window.id) {
      throw new GroveCmuxError(
        'E_PROJECTION_CONFLICT',
        `the window this grove was projected into (${ledger!.window_id}) no longer exists, and none of its workspaces were found`,
        { recorded_window: ledger!.window_id, requested_window: window.id },
        'pass --relocate to re-project here; nothing in the old window is closed',
      );
    }
  }

  return observeWindow(grove, ledger, window, opts, version, warnings);
}

async function observeWindow(
  grove: Grove,
  ledger: Ledger | null,
  window: ResolvedWindow,
  opts: ObserveOptions,
  version: CmuxVersion,
  warnings: string[],
): Promise<Observation> {
  const workspaces = await opts.client.listWorkspaces(window.id);
  const groups = await opts.client.listGroups(window.id);
  const plan = classify({ grove, ledger, workspaces, groups });
  const brand = resolveBranding();
  const report: Report = {
    grove: { name: grove.name, root: grove.root },
    cmux: { ...version, minimum_build: String(MINIMUM_CMUX_BUILD), below_minimum: false },
    window,
    ledger: {
      present: ledger !== null,
      path: ledgerPath(grove.root),
      schema: ledger?.schema ?? null,
      cmux_build: ledger?.cmux_build ?? null,
    },
    plan,
    warnings: [
      ...warnings,
      ...brand.warnings,
      ...(grove.skipped.length > 0
        ? [
            `${grove.skipped.length} director${grove.skipped.length === 1 ? 'y' : 'ies'} under trees/ ${grove.skipped.length === 1 ? 'is' : 'are'} not named ${grove.name}@<repo> and ${grove.skipped.length === 1 ? 'was' : 'were'} not projected: ${grove.skipped.join(', ')}`,
          ]
        : []),
    ],
  };
  return { grove, ledger, window, plan, report, groups };
}

export interface ApplyOptions {
  client: CmuxClient;
  allowDestructive: boolean;
  /**
   * AC-12. When named, each created Tree workspace starts `grove agent run` in its own
   * directory. `initial_command` is part of creating the workspace, so there is no window
   * between making a surface and sending text into it, and nothing is ever injected into a
   * terminal a person may already be using. Agents launch only when explicitly requested.
   */
  agent?: string | null;
  /** Defaults to the environment ladder. Injected so a test can name the values it asserts. */
  branding?: Branding;
}

export interface ApplyResult {
  applied: Action[];
  /** Branding is best-effort, so every failure arrives here rather than as a thrown error. */
  warnings: string[];
}

/**
 * Execute the classifier's actions.
 *
 * The ledger is written after every single create, not once at the end. That is what makes
 * the window in which cmux runs ahead of the ledger one RPC round trip rather than a whole
 * projection, and it is what removes crash recovery as an argument for adopting a workspace
 * by its path.
 */
export async function apply(obs: Observation, opts: ApplyOptions): Promise<ApplyResult> {
  const { grove, plan, window } = obs;
  const ledger = obs.ledger ?? emptyLedger(grove.name);
  const writer = new LedgerWriter(grove.root, ledger);
  const applied: Action[] = [];
  /** The group this run owns: created here, or named by the ledger. Never inferred. */
  let ownedGroupId: string | null = null;

  writer.recordBuild(obs.report.cmux.build);
  // Record the window before the first create, so a run that dies mid-projection still says
  // where its orphans are.
  if (plan.actions.some((a) => a.op === 'workspace.create' || a.op === 'group.create')) {
    writer.rewriteWindow(window.id);
  }

  // 1. Creates, each followed immediately by its ledger row.
  const created: string[] = [];
  for (const a of plan.actions) {
    if (a.op !== 'workspace.create' || !a.tree) continue;
    const tree = grove.trees.find((t) => t.name === a.tree);
    if (!tree) continue;
    const id = await opts.client.createWorkspace({
      windowId: window.id,
      title: shortTreeName(tree.name, grove.name),
      workingDirectory: tree.path,
      ...(opts.agent
        ? { initialCommand: agentCommand(grove.name, tree.name, opts.agent) }
        : {}),
    });
    writer.recordTree(tree.name, id);
    created.push(id);
    applied.push({ ...a, workspace_id: id });
  }

  // 2. The group. cmux generates the anchor itself; child_workspace_ids adopts the members.
  const needsGroup = plan.actions.some((a) => a.op === 'group.create');
  if (needsGroup) {
    const detached = plan.actions
      .filter((a) => a.op === 'group.attach' && a.workspace_id)
      .map((a) => a.workspace_id!);
    const children = [...created, ...detached];
    const g = await opts.client.createGroup({
      windowId: window.id,
      name: grove.name,
      cwd: grove.root,
      childWorkspaceIds: children,
    });
    writer.recordGroup({
      groupId: g.groupId,
      anchorWorkspaceId: g.anchorWorkspaceId,
      windowId: window.id,
    });
    ownedGroupId = g.groupId;
    applied.push({
      op: 'group.create',
      tree: null,
      workspace_id: g.anchorWorkspaceId,
      destructive: false,
      // The planned reason, not a constant: after an ungroup it is `not_in_group`, and an
      // executed array that disagrees with the plan it came from is the drift AC-14 forbids.
      reason: plan.actions.find((a) => a.op === 'group.create')?.reason ?? 'never_projected',
    });
    for (const id of detached) {
      applied.push({
        op: 'group.attach',
        tree: plan.actions.find((a) => a.workspace_id === id)?.tree ?? null,
        workspace_id: id,
        destructive: false,
        reason: 'not_in_group',
      });
    }
  } else {
    // 3. An existing group: attach what drifted out, and adopt the creates into it.
    //    Both sources are ledger-backed: `created` was made by this run, and every
    //    `group.attach` action comes from a `detached` item, which requires a ledger row.
    const groupId = plan.group.id ?? writer.current().group_id;
    ownedGroupId = groupId;
    if (groupId) {
      const attach = [
        ...created,
        ...plan.actions
          .filter((a) => a.op === 'group.attach' && a.workspace_id)
          .map((a) => a.workspace_id!),
      ];
      for (const id of attach) {
        await opts.client.addToGroup(groupId, id, window.id);
        if (!created.includes(id)) {
          applied.push({
            op: 'group.attach',
            tree: plan.actions.find((a) => a.workspace_id === id)?.tree ?? null,
            workspace_id: id,
            destructive: false,
            reason: 'not_in_group',
          });
        }
      }
      // The ledger must name the group it is now attached to. Recording only the window left
      // it unable to answer "did we create this group", which is what let a later run infer
      // ownership of a stranger's group from where our workspaces happened to sit.
      const current = writer.current();
      const anchorId = plan.group.anchor_workspace_id ?? current.anchor_workspace_id;
      if (current.group_id !== groupId || current.window_id !== window.id) {
        writer.recordGroup({
          groupId,
          anchorWorkspaceId: anchorId ?? '',
          windowId: window.id,
        });
      }
    }
  }

  // 4. Destruction, only under the flag, and never the anchor.
  if (opts.allowDestructive) {
    for (const a of plan.actions) {
      if (!a.destructive || !a.workspace_id) continue;
      if (a.workspace_id === writer.current().anchor_workspace_id) continue;
      await opts.client.closeWorkspace(a.workspace_id, window.id);
      if (a.tree) writer.dropTree(a.tree);
      applied.push(a);
    }
  }

  // 5. A ledger row whose workspace the person closed by hand: drop it, quietly.
  const liveIds = new Set((await opts.client.listWorkspaces(window.id)).map((w) => w.id));
  for (const [tree, uuid] of Object.entries(writer.current().trees)) {
    if (!liveIds.has(uuid)) writer.dropTree(tree);
  }

  // 6. Branding. Last, so it runs over exactly the objects that survived the reconcile, and
  //    over ledger rows only: a `foreign` group is never restyled and a workspace the ledger
  //    does not name never gets a pill. Failures are warnings, never a failed projection.
  const branding = opts.branding ?? resolveBranding().branding;
  const warnings = await applyBranding({
    client: opts.client,
    windowId: window.id,
    branding,
    groveName: grove.name,
    groupId: ownedGroupId,
    observedGroup: obs.groups.find((g) => g.id === ownedGroupId) ?? null,
    trees: Object.entries(writer.current().trees).map(([tree, workspaceId]) => ({
      tree,
      workspaceId,
    })),
  });

  return { applied, warnings };
}

export interface CloseOptions {
  groveRoot: string;
  client: CmuxClient;
  keepAnchor?: boolean;
  forget?: boolean;
  dryRun?: boolean;
}

interface CloseSnapshot {
  windows: CmuxWindow[];
  workspaces: Map<string, { workspace: CmuxWorkspace; windowId: string }>;
  groups: Array<{ group: CmuxGroup; windowId: string }>;
}

/**
 * Close exactly the objects the ledger names.
 *
 * This deliberately does not call observe(): teardown cannot inherit projection conflict or
 * path-based discovery. Every window read finishes before the first mutation, and every target
 * window comes from the live UUID scan rather than from the ledger's stale window hint.
 */
export async function closeProjection(opts: CloseOptions): Promise<Report> {
  const grove = readGroveFromDisk(opts.groveRoot);
  const ledger = readLedger(grove.root);
  if (!ledger) {
    throw new GroveCmuxError(
      'E_PRECONDITION',
      `grove ${grove.name} has no projection ledger to close`,
      { grove_root: grove.root, ledger: ledgerPath(grove.root) },
      'run grove-cmux status to inspect the Grove before closing it',
    );
  }

  // Close never brands, so a build without the branding methods is nothing to warn about here.
  const { version, warnings: capabilityWarnings, methods } = await checkCapability(
    opts.client,
    CLOSE_METHODS,
    [],
  );
  const before = await readCloseSnapshot(opts.client);
  const anchorId = ledger.anchor_workspace_id;
  const ledgerWorkspaceIds = new Set(Object.values(ledger.trees));
  if (anchorId) ledgerWorkspaceIds.add(anchorId);

  const actions: Action[] = [];
  const items: Plan['items'] = [];
  for (const tree of grove.trees) {
    const id = ledger.trees[tree.name];
    const located = id ? before.workspaces.get(id) : undefined;
    items.push({
      classification: located ? 'present' : 'missing',
      tree: tree.name,
      tree_path: tree.path,
      workspace_id: located ? id! : null,
      owned: id !== undefined,
      in_group: null,
      in_group_name: null,
      resolved_worktree: null,
      current_directory: located?.workspace.current_directory ?? null,
      reason: located ? 'projection_closed' : id ? 'workspace_not_found' : 'never_projected',
    });
  }
  for (const [tree, id] of Object.entries(ledger.trees)) {
    if (!before.workspaces.has(id)) continue;
    actions.push({
      op: 'workspace.close',
      tree,
      workspace_id: id,
      destructive: true,
      reason: 'projection_closed',
    });
  }

  const warnings = [
    ...capabilityWarnings,
    ...(grove.skipped.length > 0
      ? [`ignored non-Tree directories under trees/: ${grove.skipped.join(', ')}`]
      : []),
  ];
  let plannedUngroup: { groupId: string; windowId: string } | null = null;
  if (opts.keepAnchor) {
    plannedUngroup = planAnchorRelease(ledger, before, warnings);
    if (plannedUngroup) {
      requireUngroup(methods, version);
      actions.push({
        op: 'group.ungroup',
        tree: null,
        workspace_id: plannedUngroup.groupId,
        destructive: false,
        reason: 'projection_closed',
      });
    }
  } else if (anchorId && before.workspaces.has(anchorId)) {
    actions.push({
      op: 'workspace.close',
      tree: null,
      workspace_id: anchorId,
      destructive: true,
      reason: 'projection_closed',
    });
  }

  const reportWindow =
    (anchorId ? before.workspaces.get(anchorId)?.windowId : null)
    ?? Object.values(ledger.trees).map((id) => before.workspaces.get(id)?.windowId).find(Boolean)
    ?? ledger.window_id
    ?? '(none)';
  const report: Report = {
    grove: { name: grove.name, root: grove.root },
    cmux: { ...version, minimum_build: String(MINIMUM_CMUX_BUILD), below_minimum: false },
    window: { id: reportWindow, source: 'ledger' },
    ledger: {
      present: true,
      path: ledgerPath(grove.root),
      schema: ledger.schema,
      cmux_build: ledger.cmux_build,
    },
    plan: {
      group: closeGroupState(ledger, before),
      items,
      actions,
      summary: closeSummary(items),
    },
    warnings,
  };
  if (opts.dryRun) return report;

  const writer = new LedgerWriter(grove.root, ledger);
  const applied: Action[] = [];
  for (const action of actions) {
    if (action.op === 'workspace.close' && action.workspace_id) {
      const located = before.workspaces.get(action.workspace_id);
      if (!located) continue;
      // Ownership stays in the ledger until verification below proves the workspace gone. A
      // close cmux accepts can still leave the workspace live, and dropping its row here left
      // a retry unable to name it.
      await opts.client.closeWorkspace(action.workspace_id, located.windowId);
      applied.push(action);
    } else if (action.op === 'group.ungroup' && plannedUngroup) {
      await opts.client.rpc('workspace.group.ungroup', {
        window_id: plannedUngroup.windowId,
        group_id: plannedUngroup.groupId,
      });
      applied.push(action);
    }
  }

  // A successful RPC is not proof that the world now matches it. Re-read every window before
  // clearing or forgetting ownership; a failed read leaves the conservative ledger in place.
  //
  // The check covers every workspace the pre-run ledger named, not only the ones that became
  // actions. A ledgered id the first scan could not see and the second scan can is live, and
  // clearing or forgetting the ledger would delete the only record that it is ours.
  const after = await readCloseSnapshot(opts.client);
  for (const id of ledgerWorkspaceIds) {
    if (opts.keepAnchor && id === anchorId) continue;
    const live = after.workspaces.get(id);
    if (!live) continue;
    const planned = before.workspaces.has(id);
    throw new GroveCmuxError(
      'E_CMUX_TARGET',
      planned
        ? `workspace ${id} is still present after close`
        : `ledgered workspace ${id} was not visible before close and is present after it`,
      { workspace_id: id, window_id: live.windowId, planned },
      'retry grove-cmux close; the ledger still names every workspace that may be live',
    );
  }
  if (opts.keepAnchor && anchorId) {
    const wasLive = before.workspaces.has(anchorId);
    const isLive = after.workspaces.has(anchorId);
    if (wasLive && !isLive) {
      throw new GroveCmuxError(
        'E_CMUX_TARGET',
        `anchor workspace ${anchorId} disappeared while --keep-anchor was active`,
        { workspace_id: anchorId },
      );
    }
    if (!wasLive && isLive) {
      throw new GroveCmuxError(
        'E_CMUX_TARGET',
        `anchor workspace ${anchorId} was not visible before close and is present after it`,
        { workspace_id: anchorId, window_id: after.workspaces.get(anchorId)!.windowId },
        'retry grove-cmux close --keep-anchor; the ledger still names the anchor and its group',
      );
    }
  }
  if (plannedUngroup && after.groups.some(({ group }) => group.id === plannedUngroup!.groupId)) {
    throw new GroveCmuxError(
      'E_CMUX_TARGET',
      `group ${plannedUngroup.groupId} is still present after ungroup`,
      { group_id: plannedUngroup.groupId, window_id: plannedUngroup.windowId },
    );
  }

  // The owned group may legitimately outlive the close only because a workspace we did not
  // create still sits in it (AC-26, AC-33). Surviving with no live foreign member contradicts
  // the close: clearing group_id would leave a live owned group that nothing records.
  const survivingGroup = ledger.group_id
    ? after.groups.find(({ group }) => group.id === ledger.group_id)
    : undefined;
  if (survivingGroup) {
    const foreign = (survivingGroup.group.member_workspace_ids ?? [])
      .filter((id) => after.workspaces.has(id) && !ledgerWorkspaceIds.has(id));
    if (foreign.length === 0) {
      throw new GroveCmuxError(
        'E_CMUX_TARGET',
        `group ${survivingGroup.group.id} is still present after close and holds no foreign workspace`,
        {
          group_id: survivingGroup.group.id,
          window_id: survivingGroup.windowId,
          member_workspace_ids: survivingGroup.group.member_workspace_ids ?? [],
        },
        'retry grove-cmux close; if the group persists, dissolve it as the grove-cmux teardown guide describes, then retry',
      );
    }
    if (!opts.keepAnchor) {
      warnings.push(
        `group ${survivingGroup.group.id} outlived the close because it still holds foreign workspace${foreign.length === 1 ? '' : 's'} ${foreign.join(', ')}`,
      );
    }
  }

  if (opts.forget) {
    forgetProjection(grove.root);
    report.ledger.present = false;
  } else {
    writer.clearProjection();
  }
  report.applied = applied;
  report.plan.group = closeGroupState(ledger, after);
  return report;
}

async function readCloseSnapshot(client: CmuxClient): Promise<CloseSnapshot> {
  const windows = await client.listWindows();
  const workspaces = new Map<string, { workspace: CmuxWorkspace; windowId: string }>();
  const groups: Array<{ group: CmuxGroup; windowId: string }> = [];
  for (const window of windows) {
    let listedWorkspaces: CmuxWorkspace[];
    try {
      listedWorkspaces = await client.listWorkspaces(window.id);
    } catch (e) {
      throw closeReadError('workspaces', window.id, e);
    }
    for (const workspace of listedWorkspaces) {
      workspaces.set(workspace.id, { workspace, windowId: window.id });
    }
    let listedGroups: CmuxGroup[];
    try {
      listedGroups = await client.listGroups(window.id);
    } catch (e) {
      throw closeReadError('groups', window.id, e);
    }
    for (const group of listedGroups) groups.push({ group, windowId: window.id });
  }
  return { windows, workspaces, groups };
}

function closeReadError(kind: string, windowId: string, cause: unknown): GroveCmuxError {
  return new GroveCmuxError(
    'E_CMUX_TARGET',
    `could not read ${kind} in cmux window ${windowId}`,
    { window_id: windowId, read: kind, cause: (cause as Error)?.message ?? String(cause) },
    `check cmux window ${windowId}, then retry without deleting the ledger`,
  );
}

function requireUngroup(methods: string[], version: CmuxVersion): void {
  if (methods.includes(UNGROUP_METHOD)) return;
  const advertised = methods.length > 0;
  throw new GroveCmuxError(
    'E_CMUX_INCOMPATIBLE',
    advertised
      ? `this cmux build does not offer ${UNGROUP_METHOD}`
      : `could not confirm this cmux build offers ${UNGROUP_METHOD}: its method list is unavailable`,
    {
      observed: version.raw,
      missing: [UNGROUP_METHOD],
      method_list: advertised ? 'advertised' : 'unavailable',
    },
    `run close without --keep-anchor, or use a cmux build whose \`cmux capabilities\` lists ${UNGROUP_METHOD}`,
  );
}

function planAnchorRelease(
  ledger: Ledger,
  snapshot: CloseSnapshot,
  warnings: string[],
): { groupId: string; windowId: string } | null {
  const anchorId = ledger.anchor_workspace_id;
  const ledgerGroupId = ledger.group_id;
  const anchorGroup = anchorId
    ? snapshot.groups.find(({ group }) =>
        group.anchor_workspace_id === anchorId
        || (group.member_workspace_ids ?? []).includes(anchorId),
      )
    : null;
  if (anchorGroup && anchorGroup.group.id !== ledgerGroupId) {
    warnings.push(
      `anchor ${anchorId} is in foreign group ${anchorGroup.group.id}; the anchor and that group will be retained`,
    );
    return null;
  }
  if (!ledgerGroupId) {
    warnings.push('the ledger names no group; --keep-anchor has no group to ungroup');
    return null;
  }
  const ledgerGroup = snapshot.groups.find(({ group }) => group.id === ledgerGroupId);
  if (!ledgerGroup) {
    warnings.push(`group ${ledgerGroupId} was already gone; no ungroup is needed`);
    return null;
  }
  if (!anchorId || !snapshot.workspaces.has(anchorId)) {
    warnings.push(`group ${ledgerGroupId} was retained because its ledgered anchor is not live`);
    return null;
  }
  if (!(ledgerGroup.group.member_workspace_ids ?? []).includes(anchorId)) {
    warnings.push(`group ${ledgerGroupId} was retained because it does not hold anchor ${anchorId}`);
    return null;
  }
  const allowed = new Set([...Object.values(ledger.trees), anchorId]);
  const foreign = (ledgerGroup.group.member_workspace_ids ?? [])
    .filter((id) => snapshot.workspaces.has(id) && !allowed.has(id));
  if (foreign.length > 0) {
    warnings.push(
      `group ${ledgerGroupId} was left intact because it holds foreign workspace${foreign.length === 1 ? '' : 's'} ${foreign.join(', ')}`,
    );
    return null;
  }
  return { groupId: ledgerGroupId, windowId: ledgerGroup.windowId };
}

function closeGroupState(ledger: Ledger, snapshot: CloseSnapshot): Plan['group'] {
  const found = ledger.group_id
    ? snapshot.groups.find(({ group }) => group.id === ledger.group_id)?.group
    : null;
  if (found) {
    return {
      id: found.id,
      name: found.name ?? null,
      anchor_workspace_id: found.anchor_workspace_id ?? null,
      state: 'present',
    };
  }
  if (ledger.group_id) {
    return {
      id: ledger.group_id,
      name: null,
      anchor_workspace_id: ledger.anchor_workspace_id,
      state: 'missing',
    };
  }
  return { id: null, name: null, anchor_workspace_id: null, state: 'never_created' };
}

function closeSummary(items: Plan['items']): Plan['summary'] {
  const summary: Plan['summary'] = {
    present: 0,
    detached: 0,
    missing: 0,
    stale: 0,
    foreign: 0,
    ignore: 0,
  };
  for (const item of items) summary[item.classification] += 1;
  return summary;
}

/**
 * The launch is a single call, so there is no race between surface and command.
 *
 * The trailing `exec` is load-bearing, not decoration. cmux closes a workspace as soon as its
 * `initial_command` exits — measured live: three workspaces were gone within two seconds of
 * their agents finishing, while the agents themselves had run correctly. Without this the
 * workspace vanishes the moment the agent stops, taking its scrollback with it, and an agent
 * that fails on startup leaves nothing at all to look at. Dropping to a login shell in the
 * Tree keeps the terminal, which is what AC-12 means by the workspace surviving its agent.
 */
export function agentCommand(
  grove: string,
  tree: string,
  agent: string | null,
  argv: string[] = [],
): string {
  // The command runs inside a cmux terminal, so it has to name the same grove this process
  // was told to use. Hardcoding "grove" here made GROVE_BIN a documented lie on the one path
  // where PATH is not this process's PATH.
  const bin = process.env.GROVE_BIN ?? 'grove';
  const parts = [
    shellQuote(bin),
    'agent',
    'run',
    shellQuote(grove),
    '--tree',
    shellQuote(tree),
  ];
  // With no agent named, grove resolves the Tree's own default, which is its documented
  // behaviour and a thing a person can reasonably want.
  if (agent) parts.push('--agent', shellQuote(agent));
  // grove forwards everything after `--` to the agent verbatim, multi-word arguments
  // included, so a task prompt survives as one argument.
  if (argv.length > 0) parts.push('--', ...argv.map(shellQuote));
  return `${parts.join(' ')}; exec "\${SHELL:-/bin/zsh}" -l`;
}

/**
 * D8: hand a task to an agent in a Tree that is already projected.
 *
 * `workspace.create`'s initial_command fires only at creation, so it can launch an agent
 * exactly once per Tree and never again. A handoff is a repeat operation against a Grove that
 * is already open, which is why this goes through `surface.create` instead: a new terminal
 * inside the Tree's existing workspace, with the command attached at creation. There is still
 * no window between making a surface and sending text into it, and still nothing injected
 * into a terminal a person is already using.
 *
 * The workspace id is the ledger's. That is what keeps this inside D3: the surface is created
 * in an object we recorded, never in one found by matching a path.
 */
export async function launchAgent(o: {
  client: CmuxClient;
  windowId: string;
  workspaceId: string;
  grove: Grove;
  tree: Tree;
  agent: string | null;
  argv: string[];
}): Promise<{ surface_id: string; workspace_id: string; tree: string; command: string }> {
  const command = agentCommand(o.grove.name, o.tree.name, o.agent, o.argv);
  const r = await o.client.createSurface({
    windowId: o.windowId,
    workspaceId: o.workspaceId,
    workingDirectory: o.tree.path,
    initialCommand: command,
  });
  return {
    surface_id: r.surfaceId,
    workspace_id: r.workspaceId,
    tree: o.tree.name,
    command,
  };
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'"'"'`)}'`;
}
