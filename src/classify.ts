/**
 * The classifier.
 *
 * One classifier produces one item list and one action list. `status` prints them,
 * `sync --dry-run` prints them, and `sync` executes them. The human and JSON renderers are
 * pure functions of this output and compute nothing of their own — that is the only way the
 * two renderings cannot drift apart.
 *
 * Seven classifications. `detached` earns its own name because its remedy differs from
 * `missing`: re-attach rather than create. Collapsing them would create a duplicate in the
 * exact case the ledger exists for, which is a person dissolving the group and leaving four
 * live workspaces belonging to nothing.
 */

import type { CmuxGroup, CmuxWorkspace } from './cmux.ts';
import type { Grove, Tree } from './grove.ts';
import type { Ledger } from './ledger.ts';
import { realpathQuiet, resolveWorktree } from './git.ts';

export type Classification =
  | 'present'
  | 'detached'
  | 'missing'
  | 'stale'
  | 'foreign'
  | 'ignore';

export type Reason =
  | 'in_group'
  | 'not_in_group'
  | 'workspace_not_found'
  | 'never_projected'
  | 'tree_removed'
  | 'projection_closed'
  | 'not_in_ledger'
  | 'unrelated';

export type ActionOp =
  | 'workspace.create'
  | 'group.create'
  | 'group.attach'
  | 'group.ungroup'
  | 'workspace.close';

export interface Action {
  op: ActionOp;
  tree: string | null;
  workspace_id: string | null;
  destructive: boolean;
  reason: Reason;
}

export interface Item {
  classification: Classification;
  tree: string | null;
  tree_path: string | null;
  workspace_id: string | null;
  owned: boolean;
  in_group: string | null;
  in_group_name: string | null;
  resolved_worktree: string | null;
  current_directory: string | null;
  reason: Reason;
}

export interface GroupState {
  id: string | null;
  name: string | null;
  anchor_workspace_id: string | null;
  state: 'present' | 'missing' | 'dissolved' | 'never_created';
}

export interface Plan {
  group: GroupState;
  items: Item[];
  actions: Action[];
  summary: Record<Classification, number>;
}

export interface ClassifyInput {
  grove: Grove;
  ledger: Ledger | null;
  workspaces: CmuxWorkspace[];
  groups: CmuxGroup[];
}

export function classify(input: ClassifyInput): Plan {
  const { grove, workspaces, groups } = input;
  const ledger = input.ledger;
  const ledgerTrees = ledger?.trees ?? {};

  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const groupOf = new Map<string, CmuxGroup>();
  for (const g of groups) {
    for (const m of g.member_workspace_ids ?? []) groupOf.set(m, g);
    if (g.anchor_workspace_id) groupOf.set(g.anchor_workspace_id, g);
  }

  const groveRootReal = realpathQuiet(grove.root);
  const treeByPath = new Map<string, Tree>();
  for (const t of grove.trees) {
    const rp = realpathQuiet(t.path);
    if (rp) treeByPath.set(rp, t);
  }

  const ours = resolveOurGroup(ledger, groups);

  const items: Item[] = [];
  const actions: Action[] = [];
  const claimed = new Set<string>();

  // 1. Trees Grove knows about, keyed by the ledger. The ledger is the only ownership test.
  for (const tree of grove.trees) {
    const uuid = ledgerTrees[tree.name];
    if (uuid && wsById.has(uuid)) {
      claimed.add(uuid);
      const g = groupOf.get(uuid) ?? null;
      const inOurGroup = ours.group !== null && g !== null && g.id === ours.group.id;
      const ws = wsById.get(uuid)!;
      if (inOurGroup) {
        items.push(makeItem('present', tree, uuid, ws, g, 'in_group', true));
      } else {
        // Wherever it has ended up, including split across two strangers' groups, the repair
        // is the same: reclaim it into ours. That names only our own workspace id; cmux's
        // move semantics do the removal, which is the same thing that happens for a single
        // group and was already settled.
        items.push(makeItem('detached', tree, uuid, ws, g, 'not_in_group', true));
        actions.push({
          op: 'group.attach',
          tree: tree.name,
          workspace_id: uuid,
          destructive: false,
          reason: 'not_in_group',
        });
      }
      continue;
    }

    // A ledger row whose workspace is gone, and a Tree never projected, both need a create.
    const reason: Reason = uuid ? 'workspace_not_found' : 'never_projected';
    items.push({
      classification: 'missing',
      tree: tree.name,
      tree_path: tree.path,
      workspace_id: null,
      owned: uuid !== undefined,
      in_group: null,
      in_group_name: null,
      resolved_worktree: null,
      current_directory: null,
      reason,
    });
    actions.push({
      op: 'workspace.create',
      tree: tree.name,
      workspace_id: null,
      destructive: false,
      reason,
    });
  }

  // 2. Ledger rows whose Tree is gone from disk. Stale by default; the flag closes them.
  const onDisk = new Set(grove.trees.map((t) => t.name));
  for (const [treeName, uuid] of Object.entries(ledgerTrees)) {
    if (onDisk.has(treeName)) continue;
    if (!wsById.has(uuid)) continue; // person closed it by hand; sync drops the row silently
    claimed.add(uuid);
    const ws = wsById.get(uuid)!;
    const g = groupOf.get(uuid) ?? null;
    items.push({
      classification: 'stale',
      tree: treeName,
      tree_path: null,
      workspace_id: uuid,
      owned: true,
      in_group: g?.id ?? null,
      in_group_name: g?.name ?? null,
      resolved_worktree: resolveWorktree(ws.current_directory),
      current_directory: ws.current_directory ?? null,
      reason: 'tree_removed',
    });
    actions.push({
      op: 'workspace.close',
      tree: treeName,
      workspace_id: uuid,
      destructive: true,
      reason: 'tree_removed',
    });
  }

  // 3. Everything else in the window. Never ours, never touched, only reported.
  //    Every anchor the ledger has ever recorded counts as ours, not just the current group's.
  //    Taking only the first of the two made a workspace grove-cmux created and the ledger
  //    still names render as `foreign  not_in_ledger` the moment the group changed.
  const knownAnchors = new Set(
    [ours.group?.anchor_workspace_id, ledger?.anchor_workspace_id].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    ),
  );
  for (const ws of workspaces) {
    if (claimed.has(ws.id)) continue;
    if (knownAnchors.has(ws.id)) continue;
    const g = groupOf.get(ws.id) ?? null;
    const worktree = resolveWorktree(ws.current_directory);
    const cwdReal = realpathQuiet(ws.current_directory);
    const relatedTree =
      (worktree ? treeByPath.get(worktree) : undefined) ??
      (cwdReal ? treeByPath.get(cwdReal) : undefined) ??
      null;
    const atGroveRoot = groveRootReal !== null && cwdReal === groveRootReal;

    if (relatedTree || atGroveRoot) {
      items.push({
        classification: 'foreign',
        tree: relatedTree ? relatedTree.name : null,
        tree_path: relatedTree ? relatedTree.path : grove.root,
        workspace_id: ws.id,
        owned: false,
        in_group: g?.id ?? null,
        in_group_name: g?.name ?? null,
        resolved_worktree: worktree,
        current_directory: ws.current_directory ?? null,
        reason: 'not_in_ledger',
      });
    } else {
      items.push({
        classification: 'ignore',
        tree: null,
        tree_path: null,
        workspace_id: ws.id,
        owned: false,
        in_group: g?.id ?? null,
        in_group_name: g?.name ?? null,
        resolved_worktree: worktree,
        current_directory: ws.current_directory ?? null,
        reason: 'unrelated',
      });
    }
  }

  // 4. The group itself. `dissolved` is the ungroup case: the ledger names a group that no
  //    longer exists while our workspaces are alive, so sync makes a new one and re-attaches.
  //    A Grove with no Trees still gets its group: the anchor is the Grove in the sidebar,
  //    so an empty Grove that projected nothing would be indistinguishable from one that was
  //    never opened.
  const group = describeGroup(ledger, ours, items);
  if (group.state !== 'present') {
    actions.unshift({
      op: 'group.create',
      tree: null,
      workspace_id: null,
      destructive: false,
      reason: group.state === 'dissolved' ? 'not_in_group' : 'never_projected',
    });
  }

  return { group, items, actions, summary: summarise(items) };
}

interface OurGroup {
  group: CmuxGroup | null;
}

/**
 * Which group is ours is answered by the ledger and by nothing else: the recorded group id if
 * it still exists, otherwise the group anchored on our recorded anchor workspace.
 *
 * It is deliberately NOT "the group our workspaces are sitting in". A person can dissolve our
 * group and drag our workspaces into one of their own, and reading ownership off that position
 * made the wrapper grow a stranger's group and then record it as this Grove's. Position is
 * never evidence of ownership, and that holds for a group exactly as it holds for a workspace.
 *
 * There is no override. `--anchor` used to let a person name a group from the set holding our
 * workspaces, which is the same position inference behind a flag, and it could be used where
 * there was nothing to disambiguate at all. It is gone, and nothing is lost: when no group is
 * ours our workspaces are `detached`, and reclaiming them into a new group names only our own
 * ids whether they sit in one stranger's group or five.
 */
function resolveOurGroup(ledger: Ledger | null, groups: CmuxGroup[]): OurGroup {
  if (!ledger) return { group: null };
  if (ledger.group_id) {
    const byId = groups.find((g) => g.id === ledger.group_id);
    if (byId) return { group: byId };
  }
  if (ledger.anchor_workspace_id) {
    const byAnchor = groups.find((g) => g.anchor_workspace_id === ledger.anchor_workspace_id);
    if (byAnchor) return { group: byAnchor };
  }
  return { group: null };
}

function describeGroup(ledger: Ledger | null, ours: OurGroup, items: Item[]): GroupState {
  if (ours.group) {
    return {
      id: ours.group.id,
      name: ours.group.name ?? null,
      anchor_workspace_id: ours.group.anchor_workspace_id ?? null,
      state: 'present',
    };
  }
  if (!ledger || !ledger.group_id) {
    return { id: null, name: null, anchor_workspace_id: null, state: 'never_created' };
  }
  // The ledger names a group that is gone. If our workspaces are still alive it was
  // dissolved by an ungroup; if nothing of ours is alive it is simply missing.
  const anyAlive = items.some((i) => i.owned && i.workspace_id !== null);
  return {
    id: ledger.group_id,
    name: null,
    anchor_workspace_id: ledger.anchor_workspace_id,
    state: anyAlive ? 'dissolved' : 'missing',
  };
}

function makeItem(
  classification: Classification,
  tree: Tree,
  uuid: string,
  ws: CmuxWorkspace,
  g: CmuxGroup | null,
  reason: Reason,
  owned: boolean,
): Item {
  return {
    classification,
    tree: tree.name,
    tree_path: tree.path,
    workspace_id: uuid,
    owned,
    in_group: g?.id ?? null,
    in_group_name: g?.name ?? null,
    resolved_worktree: resolveWorktree(ws.current_directory),
    current_directory: ws.current_directory ?? null,
    reason,
  };
}

function summarise(items: Item[]): Record<Classification, number> {
  const s: Record<Classification, number> = {
    present: 0,
    detached: 0,
    missing: 0,
    stale: 0,
    foreign: 0,
    ignore: 0,
  };
  for (const i of items) s[i.classification] += 1;
  return s;
}

/** Actions a default (additive) run performs. */
export function additiveActions(actions: Action[]): Action[] {
  return actions.filter((a) => !a.destructive);
}

export function destructiveActions(actions: Action[]): Action[] {
  return actions.filter((a) => a.destructive);
}
