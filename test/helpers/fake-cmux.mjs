#!/usr/bin/env node
/**
 * A fake cmux binary.
 *
 * Implements the subset of the real control surface grove-cmux calls, backed by a JSON state
 * file named by FAKE_CMUX_STATE. It reproduces the properties the live evidence established,
 * including the ones that bite:
 *
 *   - workspace.create takes `working_directory` and `title`. Passing the CLI spellings
 *     `cwd` and `name` is accepted and ignored, producing an untitled workspace in the
 *     default directory — exactly as the real build does.
 *   - workspace.group.create generates its own anchor and adopts child_workspace_ids.
 *   - workspace.group.ungroup dissolves the group and keeps every workspace alive.
 *   - workspace.close removes an emptied group and promotes a surviving member when it closes
 *     the anchor. Measured live on 2026-09-06: a three-member group went 3→2→1→0 and
 *     disappeared only at zero.
 *   - groups and workspaces are window-local: `window_id` outranks the id, so closing a
 *     workspace or ungrouping a group through a window that does not hold it is not_found.
 *   - an unknown window_id is "unavailable: TabManager not available".
 *   - `capabilities` answers JSON whose `methods` lists the RPC methods, as build 102 does.
 *     The fake advertises exactly the methods it implements. `capabilities: null` in the state
 *     makes the command fail (discovery unavailable); an explicit array is advertised verbatim.
 *     `missing_methods` removes methods from the default advertisement AND makes calling them
 *     answer an unknown-method error, so a build that lacks a method can be modelled honestly.
 *   - workspace.group.set_icon stores only a symbol the catalogue can render; anything else
 *     is stored as null and the header keeps its default, with no error. That is what the
 *     real build does, and it is why an invalid symbol is a silent no-op rather than a
 *     refusal.
 *   - `set-status` is a CLI subcommand, not an rpc method: the real cmux CLI translates it
 *     into the legacy v1 line `set_status <key> <value> --tab=<uuid>`. It answers "OK" in
 *     prose, never JSON.
 *
 * FAKE_CMUX_FAIL_AFTER=<n> makes the nth mutating call fail, which is how partial-failure
 * recovery is exercised without a crash.
 * FAKE_CMUX_FAIL_READ=<method>, with optional FAKE_CMUX_FAIL_READ_WINDOW and
 * FAKE_CMUX_FAIL_READ_AFTER=<n>, makes matching reads after the nth one fail.
 * FAKE_CMUX_HIDE_WORKSPACE=<id> with FAKE_CMUX_HIDE_LIST_CALLS=<n> omits that workspace from
 * the first n `workspace.list` answers in the journal, modelling a workspace that is briefly
 * invisible (a restore or a concurrent move) and then reappears.
 * FAKE_CMUX_KEEP_EMPTY_GROUPS=1 leaves a group in place when its last member closes, modelling
 * delayed or failed group cleanup.
 * FAKE_CMUX_REJECT_BRANDING=1 makes every branding call fail, which is how an older cmux
 * that cannot brand is exercised without an older cmux.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const statePath = process.env.FAKE_CMUX_STATE;
if (!statePath) {
  process.stderr.write('FAKE_CMUX_STATE is not set\n');
  process.exit(1);
}

function load() {
  if (!existsSync(statePath)) {
    return {
      version: '0.64.22 (102) [ddd4a01bc]',
      windows: [{ id: 'W1', title: 'window one' }],
      workspaces: {},
      groups: {},
      status: {},
      mutations: 0,
      calls: [],
      password: null,
      running: true,
    };
  }
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function save(s) {
  writeFileSync(statePath, JSON.stringify(s, null, 2));
}

let ok = (result, createdIds) => {
  if (createdIds && createdIds.length > 0) {
    // Attribution, not inference: the watcher reads these instead of guessing which of the
    // ids that appeared were made by the run under test rather than by a person.
    const last = state.calls[state.calls.length - 1];
    if (last) {
      last.created = createdIds;
      save(state);
    }
  }
  process.stdout.write(JSON.stringify({ result }));
  process.exit(0);
};

function err(code, message) {
  process.stdout.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
}

const state = load();
const argv = process.argv.slice(2);
const cmd = argv[0];

// Record every invocation, not only the rpc ones. A journal blind to `version`,
// `capabilities` and `list-windows` would let a mutation written that way pass unseen.
// `set-status` records its parsed arguments, because the capability rule is checked against
// the ids a call names and a call whose params were blank would name none.
if (cmd !== 'rpc') {
  state.calls.push({ method: cmd, params: cmd === 'set-status' ? parseSetStatus(argv) : {} });
  save(state);
}

function parseSetStatus(av) {
  const positional = [];
  const opts = {};
  for (let i = 1; i < av.length; i++) {
    const t = av[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > 0) opts[t.slice(2, eq)] = t.slice(eq + 1);
      else opts[t.slice(2)] = av[++i];
    } else {
      positional.push(t);
    }
  }
  return {
    key: positional[0] ?? null,
    value: positional.slice(1).join(' '),
    workspace_id: opts.workspace ?? null,
    icon: opts.icon ?? null,
    color: opts.color ?? null,
    priority: opts.priority ?? null,
  };
}

if (!state.running) {
  process.stderr.write('could not connect to cmux control socket: connection refused\n');
  process.exit(1);
}

if (state.password && process.env.CMUX_SOCKET_PASSWORD !== state.password) {
  process.stderr.write('unauthorized: socket password rejected\n');
  process.exit(1);
}

if (cmd === 'version') {
  process.stdout.write(`${state.version}\n`);
  process.exit(0);
}

const IMPLEMENTED_METHODS = [
  'workspace.list',
  'workspace.create',
  'workspace.close',
  'workspace.group.list',
  'workspace.group.create',
  'workspace.group.add',
  'workspace.group.ungroup',
  'workspace.group.set_icon',
  'workspace.group.set_color',
  'surface.create',
];
const missingMethods = new Set(state.missing_methods ?? []);

if (cmd === 'capabilities') {
  if (state.capabilities === null) process.exit(1);
  const methods = state.capabilities
    ?? IMPLEMENTED_METHODS.filter((method) => !missingMethods.has(method));
  process.stdout.write(JSON.stringify({ methods }));
  process.exit(0);
}

if (cmd === 'list-windows') {
  process.stdout.write(JSON.stringify({ windows: state.windows }));
  process.exit(0);
}

if (cmd === 'set-status') {
  const p = parseSetStatus(argv);
  if (process.env.FAKE_CMUX_REJECT_BRANDING === '1') {
    // The v1 protocol reports failure in prose on stdout, not as a JSON error body.
    process.stdout.write('ERROR: Unknown command set_status\n');
    process.exit(1);
  }
  if (!p.key || !p.workspace_id) {
    process.stdout.write('ERROR: Missing status key or value\n');
    process.exit(1);
  }
  if (!state.workspaces[p.workspace_id]) {
    process.stdout.write('ERROR: Tab not found\n');
    process.exit(1);
  }
  // Last write per key wins, which is why a stable key overwrites rather than accumulates.
  state.status = state.status ?? {};
  state.status[p.workspace_id] = state.status[p.workspace_id] ?? {};
  state.status[p.workspace_id][p.key] = {
    value: p.value,
    icon: p.icon,
    color: p.color,
    priority: p.priority === null ? 0 : Number(p.priority),
  };
  save(state);
  process.stdout.write('OK\n');
  process.exit(0);
}

if (cmd === 'identify') {
  process.stdout.write(
    JSON.stringify({
      caller: state.caller ? { window_id: state.caller } : null,
      focused: state.focused ? { window_id: state.focused } : null,
    }),
  );
  process.exit(0);
}

if (cmd !== 'rpc') {
  process.stderr.write(`unknown command ${cmd}\n`);
  process.exit(1);
}

const method = argv[1];
const params = argv[2] ? JSON.parse(argv[2]) : {};
state.calls.push({ method, params });

const MUTATING = new Set([
  'workspace.create',
  'workspace.close',
  'workspace.group.create',
  'workspace.group.add',
  'workspace.group.ungroup',
  'surface.create',
  'workspace.group.set_icon',
  'workspace.group.set_color',
]);

if (missingMethods.has(method)) {
  save(state);
  err('method_not_found', `Unknown method: ${method}`);
}

const failRead = process.env.FAKE_CMUX_FAIL_READ;
const failReadWindow = process.env.FAKE_CMUX_FAIL_READ_WINDOW;
const failReadAfter = Number(process.env.FAKE_CMUX_FAIL_READ_AFTER ?? '0');
if (
  failRead === method
  && !MUTATING.has(method)
  && (!failReadWindow || params.window_id === failReadWindow)
) {
  const matchingReads = state.calls.filter(
    (call) => call.method === method
      && (!failReadWindow || call.params.window_id === failReadWindow),
  ).length;
  if (matchingReads > failReadAfter) {
    save(state);
    err('unavailable', `injected ${method} failure in window ${params.window_id ?? '(none)'}`);
  }
}

const windowExists = (id) => state.windows.some((w) => w.id === id);

if (params.window_id !== undefined && !windowExists(params.window_id)) {
  save(state);
  err('unavailable', 'TabManager not available');
}

if (MUTATING.has(method)) {
  state.mutations += 1;
  const failAfter = process.env.FAKE_CMUX_FAIL_AFTER
    ? Number(process.env.FAKE_CMUX_FAIL_AFTER)
    : null;
  if (failAfter !== null && state.mutations > failAfter) {
    save(state);
    err('internal', 'injected failure');
  }
}

// The other partial state, and the one that actually threatens the invariant: cmux applied
// the mutation and the caller never learned the id, because the process died between the RPC
// returning and the ledger write. That leaves an orphan the ledger cannot name, sitting at a
// Tree path. FAKE_CMUX_FAIL_AFTER fails before applying, so every state it builds is one
// where cmux and the ledger agree.
const failAfterApplying = process.env.FAKE_CMUX_FAIL_AFTER_APPLYING
  ? Number(process.env.FAKE_CMUX_FAIL_AFTER_APPLYING)
  : null;
if (failAfterApplying !== null && MUTATING.has(method) && state.mutations > failAfterApplying) {
  const realOk = ok;
  // eslint-disable-next-line no-func-assign
  ok = (result, createdIds) => {
    if (createdIds && createdIds.length > 0) {
      const last = state.calls[state.calls.length - 1];
      if (last) last.created = createdIds;
    }
    save(state);
    process.stderr.write('died after applying\n');
    process.exit(70);
  };
  void realOk;
}

/**
 * cmux closes a workspace when its `initial_command` exits. Measured live: three workspaces
 * were gone within two seconds of their agents finishing.
 *
 * The rule cmux applies is about the *process*, so this models the process: whatever the
 * shell runs last is what has to still be running when the command is done. An earlier
 * version tested the command for the literal `; exec ` that the wrapper appends, which made
 * the offline case a tautology — it could only ever confirm that the code still contained the
 * string the code puts there. This version fails a command that appends the keepalive and
 * then runs something after it, or that execs something which exits, neither of which the
 * literal check could see. The live suite remains the authority; this is the approximation.
 */
function survivesItsCommand(cmd) {
  if (cmd === null) return true; // no command at all: the workspace's own shell, which stays
  const last = String(cmd).split(/;|&&|\|\|/).pop().trim();
  return /^exec\s+("?\$\{?SHELL|\S*\/?(?:sh|bash|zsh|fish)\b)/.test(last);
}

/**
 * A stand-in for the SF Symbol catalogue. It only has to distinguish "renders" from "does
 * not", which is the whole of the behaviour that matters: an unrenderable name is stored as
 * null and the header falls back to folder.fill, with no error to the caller.
 */
const RENDERABLE_SYMBOLS = new Set([
  'leaf.fill', 'folder.fill', 'hammer', 'sparkle', 'ladybug.fill', 'tree.fill', 'circle.fill',
]);

const wsList = (windowId) => Object.values(state.workspaces).filter((w) => w.window_id === windowId);
const grpList = (windowId) => Object.values(state.groups).filter((g) => g.window_id === windowId);

switch (method) {
  case 'workspace.list': {
    // Reap anything whose initial_command has "finished".
    for (const w of Object.values(state.workspaces)) {
      if (w.ephemeral) {
        delete state.workspaces[w.id];
        for (const g of Object.values(state.groups)) {
          g.member_workspace_ids = g.member_workspace_ids.filter((m) => m !== w.id);
        }
      }
    }
    const hidden = process.env.FAKE_CMUX_HIDE_WORKSPACE;
    const hideCalls = Number(process.env.FAKE_CMUX_HIDE_LIST_CALLS ?? '0');
    const listCalls = state.calls.filter((call) => call.method === 'workspace.list').length;
    const visible = wsList(params.window_id)
      .filter((w) => !(hidden && w.id === hidden && listCalls <= hideCalls));
    save(state);
    ok({
      workspaces: visible.map((w) => ({
        id: w.id,
        custom_title: w.title,
        current_directory: w.current_directory,
      })),
    });
    break;
  }
  case 'workspace.group.list': {
    save(state);
    ok({
      groups: grpList(params.window_id).map((g) => ({
        id: g.id,
        name: g.name,
        anchor_workspace_id: g.anchor_workspace_id,
        member_workspace_ids: g.member_workspace_ids,
        icon_symbol: g.icon_symbol ?? null,
        custom_color: g.custom_color ?? null,
      })),
    });
    break;
  }
  case 'workspace.create': {
    const id = randomUUID();
    // cmux closes a workspace as soon as its initial_command exits. Measured live: three
    // workspaces were gone within two seconds of their agents finishing. Modelling the field
    // as inert let the offline suite agree that a workspace outlives its agent when it does
    // not, so a command with no keepalive marks the workspace ephemeral and it disappears
    // from the next listing.
    const cmd = params.initial_command ?? null;
    const ephemeral = !survivesItsCommand(cmd);
    // The mismatch is deliberate: `title`/`working_directory` are the RPC names, and the
    // CLI spellings are silently ignored, which is how the real build behaves.
    state.workspaces[id] = {
      id,
      window_id: params.window_id,
      title: params.title ?? null,
      current_directory: params.working_directory ?? process.env.HOME ?? '/',
      initial_command: cmd,
      ephemeral,
    };
    save(state);
    ok({ workspace_id: id, group_id: null }, [id]);
    break;
  }
  case 'surface.create': {
    // `workspace_id` is a routing selector: cmux resolves it ahead of the pane and echoes
    // back the workspace it actually used. Without it the pane would default to the focused
    // one, so a fake that ignored the field would let a wrapper bug route a launch into
    // whatever the person was looking at and still pass.
    const target = state.workspaces[params.workspace_id];
    if (!target) {
      save(state);
      err('not_found', 'Workspace not found');
    }
    const surfaceId = randomUUID();
    const paneId = randomUUID();
    state.surfaces ??= {};
    state.surfaces[surfaceId] = {
      id: surfaceId,
      pane_id: paneId,
      window_id: target.window_id,
      workspace_id: target.id,
      current_directory: params.working_directory ?? target.current_directory,
      initial_command: params.initial_command ?? null,
      // A surface whose command exits takes the surface with it, not the workspace.
      ephemeral: !survivesItsCommand(params.initial_command ?? null),
    };
    save(state);
    ok(
      {
        surface_id: surfaceId,
        pane_id: paneId,
        workspace_id: target.id,
        window_id: target.window_id,
        type: 'terminal',
      },
      [surfaceId],
    );
    break;
  }
  case 'workspace.group.create': {
    const anchorId = randomUUID();
    state.workspaces[anchorId] = {
      id: anchorId,
      window_id: params.window_id,
      title: params.name ?? null,
      current_directory: params.cwd ?? null,
      initial_command: null,
    };
    const gid = randomUUID();
    const children = (params.child_workspace_ids ?? []).filter(
      (c) => state.workspaces[c] && state.workspaces[c].window_id === params.window_id,
    );
    // A workspace belongs to exactly one group: adopting it moves it out of its old one.
    // Verified live — creating a second group over a member of the first left the first with
    // one fewer member and the second holding it.
    for (const g of Object.values(state.groups)) {
      g.member_workspace_ids = g.member_workspace_ids.filter((m) => !children.includes(m));
    }
    // cmux counts the anchor as a member of its own group.
    const members = [anchorId, ...children];
    state.groups[gid] = {
      id: gid,
      window_id: params.window_id,
      name: params.name ?? null,
      anchor_workspace_id: anchorId,
      member_workspace_ids: members,
      icon_symbol: null,
      custom_color: null,
    };
    save(state);
    // The live build nests the created group under a `group` key. Reproduce that.
    ok({ group: { id: gid, anchor_workspace_id: anchorId, member_workspace_ids: members, name: params.name ?? null } }, [gid, anchorId]);
    break;
  }
  case 'workspace.group.add': {
    const g = state.groups[params.group_id];
    if (!g || g.window_id !== params.window_id) {
      save(state);
      err('not_found', 'Group not found');
    }
    for (const other of Object.values(state.groups)) {
      if (other.id === g.id) continue;
      other.member_workspace_ids = other.member_workspace_ids.filter(
        (m) => m !== params.workspace_id,
      );
    }
    if (!g.member_workspace_ids.includes(params.workspace_id)) {
      g.member_workspace_ids.push(params.workspace_id);
    }
    save(state);
    ok({ ok: true });
    break;
  }
  case 'workspace.group.ungroup': {
    const g = state.groups[params.group_id];
    if (!g || (params.window_id !== undefined && g.window_id !== params.window_id)) {
      save(state);
      err('not_found', 'Group not found');
    }
    const kept = g.member_workspace_ids.length;
    delete state.groups[params.group_id];
    save(state);
    ok({ operation: 'dissolved', kept_workspace_count: kept });
    break;
  }
  case 'workspace.group.set_icon': {
    const g = state.groups[params.group_id];
    if (!g || g.window_id !== params.window_id) {
      save(state);
      err('not_found', 'Group not found');
    }
    if (process.env.FAKE_CMUX_REJECT_BRANDING === '1') {
      save(state);
      err('not_found', 'unknown method workspace.group.set_icon');
    }
    // RenderableSystemSymbol.normalized: anything the catalogue cannot render stores null.
    g.icon_symbol = RENDERABLE_SYMBOLS.has(params.symbol) ? params.symbol : null;
    save(state);
    ok({ group_id: g.id, icon_symbol: g.icon_symbol });
    break;
  }
  case 'workspace.group.set_color': {
    const g = state.groups[params.group_id];
    if (!g || g.window_id !== params.window_id) {
      save(state);
      err('not_found', 'Group not found');
    }
    if (process.env.FAKE_CMUX_REJECT_BRANDING === '1') {
      save(state);
      err('not_found', 'unknown method workspace.group.set_color');
    }
    g.custom_color = params.hex && String(params.hex).trim() ? String(params.hex).trim() : null;
    save(state);
    ok({ group_id: g.id, custom_color: g.custom_color });
    break;
  }
  case 'workspace.close': {
    const w = state.workspaces[params.workspace_id];
    if (!w || (params.window_id !== undefined && w.window_id !== params.window_id)) {
      save(state);
      err('not_found', 'Workspace not found');
    }
    delete state.workspaces[params.workspace_id];
    const keepEmpty = process.env.FAKE_CMUX_KEEP_EMPTY_GROUPS === '1';
    for (const g of Object.values(state.groups)) {
      g.member_workspace_ids = g.member_workspace_ids.filter((m) => m !== params.workspace_id);
      if (g.member_workspace_ids.length === 0) {
        if (keepEmpty) continue;
        delete state.groups[g.id];
      } else if (g.anchor_workspace_id === params.workspace_id) {
        g.anchor_workspace_id = g.member_workspace_ids[0];
      }
    }
    save(state);
    ok({ ok: true });
    break;
  }
  default:
    save(state);
    err('not_found', `unknown method ${method}`);
}
