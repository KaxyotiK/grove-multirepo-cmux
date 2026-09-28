/**
 * The cmux adapter.
 *
 * Transport is `cmux rpc <method> <json-params>`. The wrapper is a plain external process:
 * it never spawns a terminal and never needs caller context, because the RPC handlers read
 * `window_id` out of the params through cmux's routing selectors.
 *
 * RPC parameter names are not CLI flag names. `workspace.create` takes `working_directory`
 * and `title`; passing `cwd` and `name` is silently accepted and ignored, producing an
 * untitled workspace in the wrong directory while reporting success. `workspace.group.create`
 * does take `name` and `cwd`. Every name below is read from the coordinator source, never
 * inferred from `--help`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GroveCmuxError } from './errors.ts';

const execFileAsync = promisify(execFile);

/**
 * Methods `open`, `sync`, `status`, `new` and `run` require. Absence of any of these, when the
 * build advertises its methods, is E_CMUX_INCOMPATIBLE. This set is frozen: adding a method a
 * later command needs here would refuse these five commands on a build they work against.
 */
export const REQUIRED_METHODS = [
  'workspace.list',
  'workspace.create',
  'workspace.close',
  'workspace.group.list',
  'workspace.group.create',
  'workspace.group.add',
  // `run` launches into a Tree workspace that already exists, which workspace.create cannot
  // do: its initial_command fires only at creation.
  'surface.create',
] as const;

/** Methods `close` calls on every path: the window scan and the workspace closes. */
export const CLOSE_METHODS = [
  'workspace.list',
  'workspace.group.list',
  'workspace.close',
] as const;

/**
 * Called only when `close --keep-anchor` plans to dissolve the owned group. It is newer than
 * the rest of the surface grove-cmux uses, and the executor closes every Tree before it, so
 * its availability must be proven by the build's own method list before the first close:
 * learning it is absent from a failed call would strand a half-torn-down projection.
 */
export const UNGROUP_METHOD = 'workspace.group.ungroup';

/**
 * Methods grove-cmux calls for branding only. Their absence is a warning, never a refusal: a
 * build that projects Trees correctly but cannot tint a group header is not unusable, and
 * refusing on it would trade the projection for the decoration.
 *
 * `set_status` is not here because it has no v2 method to be absent from. It is reached
 * through `cmux set-status`, which speaks the legacy v1 line protocol on our behalf.
 */
export const OPTIONAL_METHODS = ['workspace.group.set_icon', 'workspace.group.set_color'] as const;

export interface CmuxWorkspace {
  id: string;
  custom_title?: string | null;
  current_directory?: string | null;
}

export interface CmuxGroup {
  id: string;
  name?: string | null;
  anchor_workspace_id?: string | null;
  member_workspace_ids?: string[];
  /** `workspace.group.list` carries both; null means the header is still cmux's default. */
  icon_symbol?: string | null;
  custom_color?: string | null;
}

export interface CmuxWindow {
  id: string;
  title?: string | null;
}

export interface CmuxVersion {
  version: string;
  build: string | null;
  hash: string | null;
  raw: string;
}

export interface CmuxCall {
  method: string;
  params: Record<string, unknown>;
}

export interface CmuxClientOptions {
  bin?: string;
  password?: string | undefined;
  /**
   * Records EVERY call issued, including the ones that do not go through `rpc`. A journal
   * that only saw `rpc` would let a mutation written the way `listWindows` is written pass
   * the read-only guard unseen.
   */
  journal?: CmuxCall[];
}

const MUTATING_METHODS = new Set([
  'workspace.create',
  'workspace.close',
  'workspace.group.create',
  'workspace.group.add',
  'workspace.group.ungroup',
  'workspace.group.rename',
  // A surface is a terminal that starts running something. Leaving it out of this set would
  // let the read-only guard on `status` pass while a command was being launched.
  'surface.create',
  // Branding. These change what a person sees, so the read-only and dry-run guards must see
  // them; `set-status` is spelled as the subprocess it is, because that is what the journal
  // records and what those guards read.
  'workspace.group.set_icon',
  'workspace.group.set_color',
  'set-status',
]);

export function isMutating(method: string): boolean {
  return MUTATING_METHODS.has(method);
}

export class CmuxClient {
  private readonly bin: string;
  private readonly password: string | undefined;
  readonly journal: CmuxCall[];

  constructor(opts: CmuxClientOptions = {}) {
    this.bin = opts.bin ?? process.env.GROVE_CMUX_CMUX_BIN ?? 'cmux';
    this.password = opts.password ?? process.env.CMUX_SOCKET_PASSWORD;
    this.journal = opts.journal ?? [];
  }

  async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.journal.push({ method, params });
    const args = ['rpc', method, JSON.stringify(params)];
    let stdout: string;
    try {
      const env = { ...process.env, CMUX_QUIET: '1' } as NodeJS.ProcessEnv;
      if (this.password !== undefined) env.CMUX_SOCKET_PASSWORD = this.password;
      const res = await execFileAsync(this.bin, args, { env, maxBuffer: 32 * 1024 * 1024 });
      stdout = res.stdout;
    } catch (e) {
      throw classifyExecFailure(e, method, params, this.bin);
    }
    return parseRpcResult<T>(stdout, method, params);
  }

  async version(): Promise<CmuxVersion> {
    let out: string;
    this.journal.push({ method: 'version', params: {} });
    try {
      const res = await execFileAsync(this.bin, ['version'], { env: withPassword(this.password) });
      out = res.stdout.trim();
    } catch (e) {
      throw classifyExecFailure(e, 'version', {}, this.bin);
    }
    return parseVersion(out);
  }

  async capabilities(): Promise<string[]> {
    this.journal.push({ method: 'capabilities', params: {} });
    try {
      const res = await execFileAsync(this.bin, ['capabilities'], { env: withPassword(this.password) });
      const parsed: unknown = JSON.parse(res.stdout);
      return extractMethodNames(parsed);
    } catch {
      // `capabilities` is itself optional on older builds. An empty list means
      // "unknown", which the caller treats as "do not refuse on this evidence".
      return [];
    }
  }

  async listWindows(): Promise<CmuxWindow[]> {
    let out: string;
    this.journal.push({ method: 'list-windows', params: {} });
    try {
      const res = await execFileAsync(this.bin, ['list-windows', '--id-format', 'uuids'], {
        env: withPassword(this.password),
      });
      out = res.stdout;
    } catch (e) {
      throw classifyExecFailure(e, 'list-windows', {}, this.bin);
    }
    return parseWindows(out);
  }

  async listWorkspaces(windowId: string): Promise<CmuxWorkspace[]> {
    const r = await this.rpc<{ workspaces?: CmuxWorkspace[] }>('workspace.list', {
      window_id: windowId,
    });
    return r.workspaces ?? [];
  }

  async listGroups(windowId: string): Promise<CmuxGroup[]> {
    const r = await this.rpc<{ groups?: CmuxGroup[] }>('workspace.group.list', {
      window_id: windowId,
    });
    return r.groups ?? [];
  }

  async createWorkspace(p: {
    windowId: string;
    title: string;
    workingDirectory: string;
    initialCommand?: string;
  }): Promise<string> {
    const params: Record<string, unknown> = {
      window_id: p.windowId,
      title: p.title,
      working_directory: p.workingDirectory,
      focus: false,
    };
    if (p.initialCommand) params.initial_command = p.initialCommand;
    const r = await this.rpc<{ workspace_id?: string; id?: string }>('workspace.create', params);
    const id = r.workspace_id ?? r.id;
    if (!id) {
      throw new GroveCmuxError(
        'E_CMUX_RPC',
        'workspace.create returned no workspace id',
        { method: 'workspace.create', response: r },
      );
    }
    return id;
  }

  async createGroup(p: {
    windowId: string;
    name: string;
    cwd: string;
    childWorkspaceIds: string[];
  }): Promise<{ groupId: string; anchorWorkspaceId: string; memberWorkspaceIds: string[] }> {
    const raw = await this.rpc<Record<string, unknown>>('workspace.group.create', {
      window_id: p.windowId,
      name: p.name,
      cwd: p.cwd,
      child_workspace_ids: p.childWorkspaceIds,
    });
    // The live build nests the created group under a `group` key; other shapes are flat.
    const r = (raw.group ?? raw) as {
      group_id?: string;
      id?: string;
      anchor_workspace_id?: string;
      member_workspace_ids?: string[];
    };
    const groupId = r.group_id ?? r.id;
    if (!groupId || !r.anchor_workspace_id) {
      throw new GroveCmuxError(
        'E_CMUX_RPC',
        'workspace.group.create returned no group or anchor id',
        { method: 'workspace.group.create', response: raw },
      );
    }
    return {
      groupId,
      anchorWorkspaceId: r.anchor_workspace_id,
      memberWorkspaceIds: r.member_workspace_ids ?? [],
    };
  }

  async addToGroup(groupId: string, workspaceId: string, windowId: string): Promise<void> {
    await this.rpc('workspace.group.add', {
      window_id: windowId,
      group_id: groupId,
      workspace_id: workspaceId,
    });
  }

  /**
   * Start a terminal inside a workspace that already exists.
   *
   * `workspace_id` is a routing selector, resolved by cmux ahead of the pane — measured
   * against the live socket, which echoed back the workspace asked for and ran the command
   * with CMUX_WORKSPACE_ID set to it. Without the selector the pane defaults to the *focused*
   * one, which is precisely the ambient targeting D3 refuses; the id here always comes from
   * the ledger.
   */
  async createSurface(p: {
    windowId: string;
    workspaceId: string;
    workingDirectory: string;
    initialCommand: string;
  }): Promise<{ surfaceId: string; workspaceId: string }> {
    const r = await this.rpc<{ surface_id?: string; workspace_id?: string }>('surface.create', {
      window_id: p.windowId,
      workspace_id: p.workspaceId,
      working_directory: p.workingDirectory,
      initial_command: p.initialCommand,
      focus: false,
    });
    if (!r.surface_id) {
      throw new GroveCmuxError('E_CMUX_RPC', 'surface.create returned no surface id', {
        method: 'surface.create',
        response: r,
      });
    }
    // cmux echoes the workspace it actually routed to. If that is not the one the ledger
    // named, the command is about to run somewhere nobody asked for, so refuse rather than
    // report a launch into the wrong Tree.
    if (r.workspace_id && r.workspace_id !== p.workspaceId) {
      throw new GroveCmuxError(
        'E_CMUX_TARGET',
        'surface.create routed to a different workspace than the one requested',
        { requested: p.workspaceId, routed_to: r.workspace_id, surface_id: r.surface_id },
      );
    }
    return { surfaceId: r.surface_id, workspaceId: r.workspace_id ?? p.workspaceId };
  }

  async closeWorkspace(workspaceId: string, windowId: string): Promise<void> {
    await this.rpc('workspace.close', { window_id: windowId, workspace_id: workspaceId });
  }

  /** O1. A symbol cmux cannot render is stored as null and the header keeps `folder.fill`. */
  async setGroupIcon(groupId: string, symbol: string, windowId: string): Promise<void> {
    await this.rpc('workspace.group.set_icon', {
      window_id: windowId,
      group_id: groupId,
      symbol,
    });
  }

  /** O1. Any hex string is accepted; passing null would clear the override. */
  async setGroupColor(groupId: string, hex: string, windowId: string): Promise<void> {
    await this.rpc('workspace.group.set_color', { window_id: windowId, group_id: groupId, hex });
  }

  /**
   * O2. The sidebar status pill.
   *
   * There is no v2 RPC for this: `set_status` exists only on the legacy v1 line protocol. So
   * this shells out to `cmux set-status`, which does the framing, the socket discovery and the
   * password for us, rather than teaching the wrapper a second transport. `--workspace` takes
   * the UUID straight through, so no window context and no caller context are needed.
   *
   * It journals under `set-status`, which is what the read-only and dry-run guards read.
   */
  async setStatus(p: {
    workspaceId: string;
    key: string;
    value: string;
    icon?: string;
    color?: string;
    priority?: number;
  }): Promise<void> {
    this.journal.push({
      method: 'set-status',
      params: {
        workspace_id: p.workspaceId,
        key: p.key,
        value: p.value,
        ...(p.icon ? { icon: p.icon } : {}),
        ...(p.color ? { color: p.color } : {}),
        ...(p.priority !== undefined ? { priority: p.priority } : {}),
      },
    });
    const args = ['set-status', p.key, p.value];
    if (p.icon) args.push('--icon', p.icon);
    if (p.color) args.push('--color', p.color);
    if (p.priority !== undefined) args.push('--priority', String(p.priority));
    args.push('--workspace', p.workspaceId);
    let stdout: string;
    try {
      const res = await execFileAsync(this.bin, args, {
        env: withPassword(this.password),
        maxBuffer: 4 * 1024 * 1024,
      });
      stdout = res.stdout;
    } catch (e) {
      throw classifyExecFailure(e, 'set-status', { workspace_id: p.workspaceId, key: p.key }, this.bin);
    }
    // The v1 protocol answers in prose, not JSON: "OK", or a line starting "ERROR:".
    if (/^ERROR:/m.test(stdout)) {
      throw classifyRpcError(
        { message: stdout.trim().split('\n')[0] },
        'set-status',
        { workspace_id: p.workspaceId, key: p.key },
      );
    }
  }
}

function withPassword(password: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env, CMUX_QUIET: '1' } as NodeJS.ProcessEnv;
  if (password !== undefined) env.CMUX_SOCKET_PASSWORD = password;
  return env;
}

export function parseVersion(raw: string): CmuxVersion {
  // Observed shape: "cmux 0.64.22 (102) [ddd4a01bc]". The leading program name is optional,
  // so the version is found by pattern rather than by position — reading it as the first
  // token gave "cmux", which made build and hash null and silently disabled the minimum
  // check. Three materially different builds share the "0.64.22" string, so build and hash
  // are recorded, never just version.
  const text = raw.trim();
  const version = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(text)?.[0] ?? text;
  const build = /\((\d+)\)/.exec(text)?.[1] ?? null;
  const hash = /\[([0-9a-f]{6,40})\]/.exec(text)?.[1] ?? null;
  return { version, build, hash, raw: text };
}

export function parseWindows(out: string): CmuxWindow[] {
  const trimmed = out.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const arr = Array.isArray(parsed)
        ? parsed
        : ((parsed as { windows?: unknown[] }).windows ?? []);
      return arr.map((w) => {
        const o = w as Record<string, unknown>;
        return { id: String(o.id ?? ''), title: (o.title as string) ?? null };
      });
    } catch {
      /* fall through to line parsing */
    }
  }
  const windows: CmuxWindow[] = [];
  for (const line of trimmed.split('\n')) {
    const id = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/.exec(
      line,
    );
    if (!id) continue;
    const title = line.replace(id[0], '').replace(/^[\s:|-]+/, '').trim();
    windows.push({ id: id[0], title: title.length > 0 ? title : null });
  }
  return windows;
}

function extractMethodNames(parsed: unknown): string[] {
  if (Array.isArray(parsed)) return parsed.map(String);
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    for (const key of ['methods', 'rpc_methods', 'capabilities']) {
      const v = o[key];
      if (Array.isArray(v)) return v.map(String);
    }
  }
  return [];
}

export function parseRpcResult<T>(
  stdout: string,
  method: string,
  params: Record<string, unknown>,
): T {
  const text = stdout.trim();
  if (text.length === 0) return {} as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GroveCmuxError('E_CMUX_RPC', `${method} returned output that is not JSON`, {
      method,
      params,
      stdout: text.slice(0, 2000),
    });
  }
  const obj = parsed as Record<string, unknown>;
  if (obj && typeof obj === 'object' && obj.error) {
    throw classifyRpcError(obj.error, method, params);
  }
  const result = obj && typeof obj === 'object' && 'result' in obj ? obj.result : parsed;
  return result as T;
}

/**
 * Two live error strings share `E_CMUX_TARGET` because the remedy has the same shape:
 * the thing you named is not in the window you named. The raw string is kept in the
 * evidence for anyone who needs to tell them apart.
 */
export function classifyRpcError(
  err: unknown,
  method: string,
  params: Record<string, unknown>,
): GroveCmuxError {
  const o = (err ?? {}) as Record<string, unknown>;
  const code = String(o.code ?? '');
  const message = String(o.message ?? JSON.stringify(err));
  const evidence = { method, params, rpc_code: code || null, rpc_error: message };

  if (/TabManager not available/i.test(message) || /Group not found/i.test(message)) {
    return new GroveCmuxError('E_CMUX_TARGET', message, evidence);
  }
  if (code === 'not_found' || code === 'unavailable') {
    return new GroveCmuxError('E_CMUX_TARGET', message, evidence);
  }
  if (code === 'unauthorized' || /password|unauthori[sz]ed/i.test(message)) {
    return new GroveCmuxError('E_CMUX_AUTH', message, evidence);
  }
  if (/unknown method|method not found|unsupported/i.test(message)) {
    return new GroveCmuxError('E_CMUX_INCOMPATIBLE', message, evidence);
  }
  return new GroveCmuxError('E_CMUX_RPC', message, evidence);
}

export function classifyExecFailure(
  e: unknown,
  method: string,
  params: Record<string, unknown>,
  bin: string,
): GroveCmuxError {
  const err = e as { code?: string | number; stderr?: string; stdout?: string; message?: string };
  const stderr = (err.stderr ?? '').toString();
  const stdout = (err.stdout ?? '').toString();

  if (err.code === 'ENOENT') {
    return new GroveCmuxError(
      'E_CMUX_UNAVAILABLE',
      `the cmux binary "${bin}" is not on PATH`,
      { bin, method },
      'install cmux, or set GROVE_CMUX_CMUX_BIN to its path',
    );
  }

  // A JSON error body on stdout is an RPC-level failure, not a transport failure.
  const body = stdout.trim();
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (parsed.error) return classifyRpcError(parsed.error, method, params);
    } catch {
      /* not JSON after all */
    }
  }

  const text = `${stderr}\n${stdout}`;
  const evidence = {
    method,
    params,
    bin,
    stderr: stderr.trim().slice(0, 2000) || null,
    exit_code: typeof err.code === 'number' ? err.code : null,
  };

  if (/password|unauthori[sz]ed|authentication/i.test(text)) {
    return new GroveCmuxError('E_CMUX_AUTH', 'cmux rejected the socket password', evidence);
  }
  // Only a message that actually points at the transport. A bare "socket" anywhere in an RPC
  // stderr, or a bare ENOENT, would otherwise report a vanished working_directory as cmux
  // being unreachable.
  if (
    /connection refused|not running|could not connect/i.test(text) ||
    /(socket|cmux\.sock)[^\n]*(not found|no such file|refused|unavailable|closed)/i.test(text) ||
    /(could not|failed to|unable to)[^\n]*(connect|open)[^\n]*socket/i.test(text)
  ) {
    return new GroveCmuxError('E_CMUX_UNAVAILABLE', 'cmux is not reachable on its control socket', evidence);
  }
  if (/TabManager not available/i.test(text) || /Group not found/i.test(text)) {
    return new GroveCmuxError('E_CMUX_TARGET', text.trim().slice(0, 300), evidence);
  }
  if (/unknown method|method not found|unknown command/i.test(text)) {
    return new GroveCmuxError('E_CMUX_INCOMPATIBLE', text.trim().slice(0, 300), evidence);
  }
  return new GroveCmuxError(
    'E_CMUX_RPC',
    (err.message ?? 'cmux call failed').toString().slice(0, 300),
    evidence,
  );
}
